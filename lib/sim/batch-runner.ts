// 시뮬레이터 배치를 동시성 N으로 전송하고, 적재 검증에 쓸 기대치와 서버 응답을 집계한다 (sim:backfill).
import type { EmitResult } from './emit-http';
import type { IngestEnvelope } from './envelope';
import type { SimulatedBatch } from './index';
import type { RunSummary, SiteTotals } from './manifest';

export const DEFAULT_MAX_FAILURES = 10;
const MAX_FAILURE_MESSAGES = 20;

export interface RunBatchesOptions {
  readonly concurrency: number;
  readonly emit: (batch: SimulatedBatch) => Promise<EmitResult>;
  /** 실패가 이만큼 쌓이면 새 배치를 꺼내지 않는다 (서버 설정 오류로 전부 실패하는 경우) */
  readonly maxFailures?: number;
  readonly onResult?: (summary: RunSummary, batch: SimulatedBatch, result: EmitResult) => void;
}

export const EMPTY_RUN_SUMMARY: RunSummary = Object.freeze({
  batches: 0,
  resends: 0,
  backfillBatches: 0,
  results: { accepted: 0, duplicate: 0, conflict: 0, failed: 0 },
  samples: { accepted: 0, duplicate: 0, rejected: 0, unmapped: 0, missing: 0, events: 0 },
  sites: {},
  sampleWindow: null,
  failures: [],
  aborted: false,
});

const EMPTY_SITE: SiteTotals = { batches: 0, expectedSamples: 0, expectedUnmappedSamples: 0, clockSuspectSamples: 0, criticalEvents: 0 };

/** 봉투에 실린 샘플 시각의 최소·최대. 샘플이 없으면 null */
export function envelopeTimeRange(envelope: Pick<IngestEnvelope, 'series'>): { readonly minTsMs: number; readonly maxTsMs: number } | null {
  const bounds = envelope.series.flatMap((series): number[] => {
    if ('ts' in series) return series.ts.length > 0 ? [Math.min(...series.ts), Math.max(...series.ts)] : [];
    return series.v.length > 0 ? [series.t0, series.t0 + series.dt * (series.v.length - 1)] : [];
  });
  return bounds.length > 0 ? { minTsMs: Math.min(...bounds), maxTsMs: Math.max(...bounds) } : null;
}

function mergeWindow(current: RunSummary['sampleWindow'], envelope: IngestEnvelope): RunSummary['sampleWindow'] {
  const range = envelopeTimeRange(envelope);
  if (!range) return current;
  if (!current) return range;
  return { minTsMs: Math.min(current.minTsMs, range.minTsMs), maxTsMs: Math.max(current.maxTsMs, range.maxTsMs) };
}

function addSiteTotals(previous: SiteTotals, batch: SimulatedBatch): SiteTotals {
  const original = !batch.resend;
  return {
    batches: previous.batches + 1,
    expectedSamples: previous.expectedSamples + batch.expectedSamples,
    expectedUnmappedSamples: previous.expectedUnmappedSamples + batch.expectedUnmappedSamples,
    clockSuspectSamples: previous.clockSuspectSamples + (original && !batch.envelope.clock.ntp_synced ? batch.expectedSamples : 0),
    criticalEvents: previous.criticalEvents + (original ? batch.envelope.events.filter((event) => event.severity === 'critical').length : 0),
  };
}

/** 배치 하나의 전송 결과를 더한 새 요약 (순수 함수) */
export function addBatchResult(summary: RunSummary, batch: SimulatedBatch, result: EmitResult): RunSummary {
  const counts = result.kind === 'accepted' || result.kind === 'duplicate' ? result.counts : null;
  const failure = result.kind === 'failed' ? `${batch.siteCode} seq ${batch.envelope.seq}: ${result.error}` : null;
  return {
    ...summary,
    batches: summary.batches + 1,
    resends: summary.resends + (batch.resend ? 1 : 0),
    backfillBatches: summary.backfillBatches + (batch.backfill ? 1 : 0),
    results: { ...summary.results, [result.kind]: summary.results[result.kind] + 1 },
    samples: counts
      ? {
          accepted: summary.samples.accepted + counts.accepted,
          duplicate: summary.samples.duplicate + counts.duplicate,
          rejected: summary.samples.rejected + counts.rejected,
          unmapped: summary.samples.unmapped + counts.unmapped,
          missing: summary.samples.missing + counts.missing,
          events: summary.samples.events + counts.events,
        }
      : summary.samples,
    sites: { ...summary.sites, [batch.siteCode]: addSiteTotals(summary.sites[batch.siteCode] ?? EMPTY_SITE, batch) },
    sampleWindow: mergeWindow(summary.sampleWindow, batch.envelope),
    failures: failure && summary.failures.length < MAX_FAILURE_MESSAGES ? [...summary.failures, failure] : summary.failures,
  };
}

async function emitSafely(emit: RunBatchesOptions['emit'], batch: SimulatedBatch): Promise<EmitResult> {
  try {
    return await emit(batch);
  } catch (error) {
    return { kind: 'failed', httpStatus: null, error: error instanceof Error ? error.message : String(error), attempts: 0 };
  }
}

/** source에서 배치를 꺼내 동시에 최대 concurrency개씩 보낸다. 시뮬레이터 오류는 그대로 던진다. */
export async function runBatches(source: AsyncIterable<SimulatedBatch>, options: RunBatchesOptions): Promise<RunSummary> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error(`concurrency는 1 이상의 정수여야 합니다: ${options.concurrency}`);
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const iterator = source[Symbol.asyncIterator]();
  let summary = EMPTY_RUN_SUMMARY;

  const worker = async (): Promise<void> => {
    while (summary.results.failed < maxFailures) {
      const next = await iterator.next(); // 비동기 제너레이터는 동시 next() 호출을 순서대로 처리한다
      if (next.done) return;
      const result = await emitSafely(options.emit, next.value);
      summary = addBatchResult(summary, next.value, result);
      options.onResult?.(summary, next.value, result);
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  if (summary.results.failed >= maxFailures) {
    await iterator.return?.();
    return { ...summary, aborted: true };
  }
  return summary;
}
