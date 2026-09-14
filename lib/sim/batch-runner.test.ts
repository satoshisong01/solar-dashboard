import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { runBatches, envelopeTimeRange } from './batch-runner';
import type { EmitResult } from './emit-http';
import { buildEnvelope, type EnvelopeSample } from './envelope';
import type { SimulatedBatch } from './index';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const COUNTS = { accepted: 0, duplicate: 0, rejected: 0, unmapped: 0, missing: 0, events: 0 };

interface BatchSpec {
  readonly site: 'SIM-A' | 'SIM-B';
  readonly seq: number;
  readonly samples?: number;
  readonly unmapped?: number;
  readonly resend?: boolean;
  readonly backfill?: boolean;
  readonly synced?: boolean;
  readonly critical?: number;
}

function batch(spec: BatchSpec): SimulatedBatch {
  const site = SIM_SITES.find((s) => s.code === spec.site);
  if (!site) throw new Error(spec.site);
  const samples: EnvelopeSample[] = Array.from({ length: (spec.samples ?? 2) + (spec.unmapped ?? 0) }, (_, i) => ({
    sourceKey: i < (spec.samples ?? 2) ? 'PV1/INV01/P_AC' : 'COMP1/VIB_RMS',
    unit: 'kW',
    periodS: 60,
    ts: T0 + spec.seq * 3_600_000 + i * 60_000,
    value: i,
  }));
  const envelope = buildEnvelope({
    seed: 1,
    gateway: site.gateway.code,
    seq: spec.seq,
    sentAtMs: T0,
    clock: { ntp_synced: spec.synced ?? true, ntp_offset_ms: 0 },
    samples,
    events: Array.from({ length: spec.critical ?? 0 }, (_, i) => ({ src: 'GD3/ALARM', ts: T0 + i, code: 'H2_LEAK_L1', severity: 'critical' as const })),
  });
  return {
    siteCode: site.code,
    gateway: site.gateway,
    envelope,
    expectedSamples: spec.resend ? 0 : (spec.samples ?? 2),
    expectedUnmappedSamples: spec.resend ? 0 : (spec.unmapped ?? 0),
    resend: spec.resend ?? false,
    backfill: spec.backfill ?? false,
    sentAtMs: T0,
  };
}

async function* source(batches: readonly SimulatedBatch[]): AsyncGenerator<SimulatedBatch> {
  for (const b of batches) yield b;
}

const accepted = (accepted: number): EmitResult => ({ kind: 'accepted', counts: { ...COUNTS, accepted }, attempts: 1 });

describe('envelopeTimeRange', () => {
  it('정주기·비정주기 시계열의 최소·최대 샘플 시각, 샘플이 없으면 null', () => {
    const regular = batch({ site: 'SIM-A', seq: 0, samples: 3 }).envelope;
    const irregular = { ...regular, series: [{ src: 'X', unit: 'kW', ts: [T0 + 5, T0 + 1, T0 + 9], v: [1, 2, 3] }] };

    expect(envelopeTimeRange(regular)).toEqual({ minTsMs: T0, maxTsMs: T0 + 120_000 });
    expect(envelopeTimeRange(irregular)).toEqual({ minTsMs: T0 + 1, maxTsMs: T0 + 9 });
    expect(envelopeTimeRange({ ...regular, series: [] })).toBeNull();
  });
});

describe('runBatches', () => {
  it('사이트별 기대치(재전송 제외)·CLOCK_SUSPECT 기대치·critical 이벤트·결과·샘플 시각 범위를 모은다', async () => {
    const batches = [
      batch({ site: 'SIM-A', seq: 0, samples: 3 }),
      batch({ site: 'SIM-A', seq: 1, samples: 4, synced: false }),
      batch({ site: 'SIM-A', seq: 1, samples: 4, synced: false, resend: true }),
      batch({ site: 'SIM-B', seq: 2, samples: 5, unmapped: 2, critical: 1, backfill: true }),
    ];
    const results: EmitResult[] = [accepted(3), accepted(4), { kind: 'duplicate', counts: { ...COUNTS, duplicate: 4 }, attempts: 1 }, { kind: 'conflict', attempts: 1 }];
    let index = 0;

    const summary = await runBatches(source(batches), { concurrency: 1, emit: async () => results[index++] ?? accepted(0) });

    expect(summary).toMatchObject({
      batches: 4,
      resends: 1,
      backfillBatches: 1,
      results: { accepted: 2, duplicate: 1, conflict: 1, failed: 0 },
      samples: { accepted: 7, duplicate: 4 },
      sites: {
        'SIM-A': { batches: 3, expectedSamples: 7, expectedUnmappedSamples: 0, clockSuspectSamples: 4, criticalEvents: 0 },
        'SIM-B': { batches: 1, expectedSamples: 5, expectedUnmappedSamples: 2, clockSuspectSamples: 0, criticalEvents: 1 },
      },
      sampleWindow: { minTsMs: T0, maxTsMs: T0 + 2 * 3_600_000 + 6 * 60_000 },
      failures: [],
      aborted: false,
    });
  });

  it('동시에 최대 concurrency개만 보낸다', async () => {
    let inFlight = 0;
    let peak = 0;
    const batches = Array.from({ length: 12 }, (_, seq) => batch({ site: 'SIM-A', seq }));

    const summary = await runBatches(source(batches), {
      concurrency: 3,
      emit: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return accepted(2);
      },
    });

    expect(peak).toBe(3);
    expect(summary.results.accepted).toBe(12);
  });

  it('실패가 maxFailures에 이르면 새 배치를 꺼내지 않고 aborted로 끝낸다. emit 예외도 실패로 센다', async () => {
    const batches = Array.from({ length: 10 }, (_, seq) => batch({ site: 'SIM-B', seq }));
    let calls = 0;

    const summary = await runBatches(source(batches), {
      concurrency: 1,
      maxFailures: 2,
      emit: async () => {
        calls += 1;
        if (calls === 1) throw new Error('예상 못한 오류');
        return { kind: 'failed', httpStatus: 401, error: '401 unknown_key: 키 없음', attempts: 1 };
      },
    });

    expect(calls).toBe(2);
    expect(summary).toMatchObject({ batches: 2, aborted: true, results: { failed: 2 } });
    expect(summary.failures).toEqual([expect.stringContaining('예상 못한 오류'), expect.stringContaining('401 unknown_key')]);
  });
});
