// sim:backfill이 남기고 verify:ingest가 읽는 적재 기록. 외부 파일이므로 읽을 때 zod로 검증한다.
import * as z from 'zod';
import { countsSchema } from './emit-http';
import { SCENARIO_PRESETS } from './presets';

export const MANIFEST_VERSION = 1;
/** 저장소 루트 기준 (.data/는 git에 올라가지 않는다) */
export const DEFAULT_MANIFEST_PATH = '.data/sim/backfill-manifest.json';

const count = z.number().int().nonnegative();
const epochMs = z.number().int().nonnegative();

export const siteTotalsSchema = z.object({
  /** 보낸 배치 수 (재전송 포함) */
  batches: count,
  /** om.measurement에 새로 들어가야 할 고유 샘플 수 (재전송·미매핑 제외) */
  expectedSamples: count,
  expectedUnmappedSamples: count,
  /** NTP 미동기 배치의 기대 샘플 수 = CLOCK_SUSPECT 비트가 붙어야 할 샘플 수 */
  clockSuspectSamples: count,
  /** severity=critical 이벤트 수 (안전 이벤트로 기록돼야 함) */
  criticalEvents: count,
});

export const runSummarySchema = z.object({
  batches: count,
  resends: count,
  backfillBatches: count,
  results: z.object({ accepted: count, duplicate: count, conflict: count, failed: count }),
  /** 서버 응답 카운트 합계 */
  samples: countsSchema,
  sites: z.record(z.string(), siteTotalsSchema),
  /** 보낸 봉투의 샘플 시각 범위 (게이트웨이 시계 오차 포함) */
  sampleWindow: z.object({ minTsMs: epochMs, maxTsMs: epochMs }).nullable(),
  failures: z.array(z.string()),
  aborted: z.boolean(),
});

export const backfillManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.iso.datetime(),
  baseUrl: z.string(),
  seed: count,
  scenario: z.enum(SCENARIO_PRESETS),
  sites: z.array(z.string()).min(1),
  fromMs: epochMs,
  toMs: epochMs,
  batchMinutes: count,
  maxSamplesPerBatch: count,
  concurrency: count,
  elapsedMs: count,
  summary: runSummarySchema,
});

export type SiteTotals = z.infer<typeof siteTotalsSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type BackfillManifest = z.infer<typeof backfillManifestSchema>;

export function parseManifest(value: unknown): BackfillManifest {
  const result = backfillManifestSchema.safeParse(value);
  if (!result.success) throw new Error(`적재 기록 형식이 올바르지 않습니다\n${z.prettifyError(result.error)}`);
  return result.data;
}
