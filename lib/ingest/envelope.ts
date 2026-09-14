// 수집 봉투 om.ingest.v1 스키마 (설계 §5.1). 순수 모듈: 시뮬레이터(lib/sim)도 import한다 ('server-only' 금지).
// v1 안에서는 선택 필드 추가만 허용하므로, 모르는 필드는 거부하지 않고 버린다 (z.object 기본 동작).
import * as z from 'zod';

export const INGEST_SCHEMA = 'om.ingest.v1';
/** 배치 하나에 들어갈 수 있는 샘플 수(series[].v 길이 합) 상한 */
export const MAX_SAMPLES_PER_BATCH = 20_000;
/** 원본 태그·단위·이벤트 코드 길이 상한 */
const MAX_KEY_LENGTH = 200;
const MAX_UNIT_LENGTH = 32;
const MAX_TEXT_LENGTH = 1_000;
/** 1초 ~ 1일 */
const MAX_DT_MS = 86_400_000;

/** epoch 밀리초 (정수, 음수 불가) */
const epochMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const EVENT_SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

const seriesSchema = z
  .object({
    src: z.string().min(1).max(MAX_KEY_LENGTH),
    unit: z.string().max(MAX_UNIT_LENGTH),
    t0: epochMs.optional(),
    dt: z.number().int().positive().max(MAX_DT_MS).optional(),
    ts: z.array(epochMs).optional(),
    v: z.array(z.number().nullable()).min(1),
    // 장치 품질 코드. 0이면 정상, 그 외는 DEVICE_BAD로 저장한다.
    q: z.array(z.number().int().min(0).max(65_535)).optional(),
  })
  .superRefine((series, ctx) => {
    const regular = series.t0 !== undefined || series.dt !== undefined;
    if (regular && series.ts !== undefined) {
      ctx.addIssue({ code: 'custom', message: 't0+dt와 ts 중 하나만 보내야 합니다', path: ['ts'] });
    } else if (regular && (series.t0 === undefined || series.dt === undefined)) {
      ctx.addIssue({ code: 'custom', message: '정주기 시계열은 t0와 dt를 함께 보내야 합니다', path: ['dt'] });
    } else if (!regular && series.ts === undefined) {
      ctx.addIssue({ code: 'custom', message: 't0+dt 또는 ts가 필요합니다', path: ['ts'] });
    }
    if (series.ts !== undefined && series.ts.length !== series.v.length) {
      ctx.addIssue({ code: 'custom', message: `ts 길이(${series.ts.length})가 v 길이(${series.v.length})와 다릅니다`, path: ['ts'] });
    }
    if (series.q !== undefined && series.q.length !== series.v.length) {
      ctx.addIssue({ code: 'custom', message: `q 길이(${series.q.length})가 v 길이(${series.v.length})와 다릅니다`, path: ['q'] });
    }
    if (series.t0 !== undefined && series.dt !== undefined && series.t0 + series.dt * (series.v.length - 1) > Number.MAX_SAFE_INTEGER) {
      ctx.addIssue({ code: 'custom', message: '마지막 샘플 시각이 범위를 벗어납니다', path: ['t0'] });
    }
  });

const eventSchema = z.object({
  src: z.string().min(1).max(MAX_KEY_LENGTH),
  ts: epochMs,
  code: z.string().min(1).max(MAX_KEY_LENGTH),
  severity: z.enum(EVENT_SEVERITIES),
  text: z.string().max(MAX_TEXT_LENGTH).optional(),
});

export const envelopeSchema = z
  .object({
    schema: z.literal(INGEST_SCHEMA),
    gateway: z.string().min(1).max(64),
    batch_id: z.uuid(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sent_at: z.iso.datetime({ offset: true }),
    clock: z.object({
      ntp_synced: z.boolean(),
      ntp_offset_ms: z.number(),
    }),
    series: z.array(seriesSchema),
    events: z.array(eventSchema),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((envelope, ctx) => {
    const samples = countSamples(envelope.series);
    if (samples > MAX_SAMPLES_PER_BATCH) {
      ctx.addIssue({
        code: 'custom',
        message: `배치 샘플 수(${samples})가 상한 ${MAX_SAMPLES_PER_BATCH}을 넘습니다`,
        path: ['series'],
      });
    }
  });

/** 봉투를 만드는 쪽(시뮬레이터)이 쓰는 입력 타입 */
export type IngestEnvelopeInput = z.input<typeof envelopeSchema>;
export type IngestEnvelope = z.output<typeof envelopeSchema>;
export type IngestSeries = IngestEnvelope['series'][number];
export type IngestEvent = IngestEnvelope['events'][number];

export function countSamples(series: readonly { readonly v: readonly unknown[] }[]): number {
  return series.reduce((sum, item) => sum + item.v.length, 0);
}

/** 시계열 샘플 시각(epoch ms) 배열. 스키마 검증을 통과한 시계열에만 쓴다. */
export function sampleTimestamps(series: IngestSeries): readonly number[] {
  if (series.ts !== undefined) return series.ts;
  const t0 = series.t0 ?? 0;
  const dt = series.dt ?? 0;
  return series.v.map((_, index) => t0 + dt * index);
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: IngestEnvelope }
  | { readonly ok: false; readonly issues: readonly string[] };

const MAX_REPORTED_ISSUES = 20;

/** JSON 값을 검증한다. 실패하면 경로가 붙은 오류 메시지를 최대 20개 돌려준다. */
export function parseEnvelope(value: unknown): EnvelopeParseResult {
  const result = envelopeSchema.safeParse(value);
  if (result.success) return { ok: true, envelope: result.data };
  const issues = result.error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
  return { ok: false, issues };
}
