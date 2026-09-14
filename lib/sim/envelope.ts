// 샘플·이벤트를 om.ingest.v1 봉투(JSON 객체)로 묶는다. 서명·gzip·HTTP 전송은 emit-http.ts가 lib/ingest/signature로 한다.
// 스키마 이름·이벤트 심각도·clock 필드는 lib/ingest/envelope(zod)와 같아야 한다 (ingest-compat.test.ts가 검사).
import { createHash } from 'node:crypto';
import { INGEST_SCHEMA } from '@/lib/ingest/envelope';
import type { SimEvent } from './events';

export { INGEST_SCHEMA };

/** 시뮬레이터 batch_id용 UUID v5 네임스페이스 (고정값) */
export const SIM_BATCH_NAMESPACE = 'd2279329-5c90-44d8-a3d7-d56d2661e063';

export type SeriesValue = number | null;

/** 정주기: ts = t0 + i × dt */
export interface RegularSeries {
  readonly src: string;
  readonly unit: string;
  readonly t0: number;
  readonly dt: number;
  readonly v: readonly SeriesValue[];
}

/** 비정주기: 샘플마다 ts */
export interface IrregularSeries {
  readonly src: string;
  readonly unit: string;
  readonly ts: readonly number[];
  readonly v: readonly SeriesValue[];
}

export type IngestSeries = RegularSeries | IrregularSeries;

export interface IngestEvent {
  readonly src: string;
  readonly ts: number;
  readonly code: string;
  readonly severity: SimEvent['severity'];
  readonly text?: string;
}

export interface GatewayClock {
  readonly ntp_synced: boolean;
  readonly ntp_offset_ms: number;
}

export interface IngestEnvelope {
  readonly schema: typeof INGEST_SCHEMA;
  readonly gateway: string;
  readonly batch_id: string;
  readonly seq: number;
  readonly sent_at: string;
  readonly clock: GatewayClock;
  readonly series: readonly IngestSeries[];
  readonly events: readonly IngestEvent[];
}

export interface EnvelopeSample {
  readonly sourceKey: string;
  readonly unit: string;
  readonly periodS: number;
  /** 게이트웨이가 찍은 시각 (시계 오차 포함) */
  readonly ts: number;
  readonly value: SeriesValue;
}

export interface EnvelopeInput {
  readonly seed: number;
  readonly gateway: string;
  readonly seq: number;
  /** 게이트웨이 시계 기준 전송 시각 */
  readonly sentAtMs: number;
  readonly clock: GatewayClock;
  readonly samples: readonly EnvelopeSample[];
  readonly events: readonly SimEvent[];
}

/** RFC 4122 UUID v5 (SHA-1, 이름 기반) */
export function uuidV5(name: string, namespace: string = SIM_BATCH_NAMESPACE): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (namespaceBytes.length !== 16) throw new Error(`UUID 네임스페이스가 올바르지 않습니다: ${namespace}`);
  const bytes = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 원본 태그별로 묶는다. 주기 간격으로 이어지면 t0+dt, 아니면 ts[] (등장 순서 유지). */
export function buildSeries(samples: readonly EnvelopeSample[]): IngestSeries[] {
  const groups = new Map<string, EnvelopeSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.sourceKey);
    if (group) group.push(sample);
    else groups.set(sample.sourceKey, [sample]);
  }
  return [...groups.values()].map((group): IngestSeries => {
    const [first] = group;
    if (!first) throw new Error('빈 시계열 그룹');
    const dt = first.periodS * 1000;
    const regular = group.every((s, i) => s.ts === first.ts + i * dt && s.unit === first.unit);
    const v = group.map((s) => s.value);
    return regular
      ? { src: first.sourceKey, unit: first.unit, t0: first.ts, dt, v }
      : { src: first.sourceKey, unit: first.unit, ts: group.map((s) => s.ts), v };
  });
}

const toIngestEvent = (event: SimEvent): IngestEvent =>
  event.text === undefined
    ? { src: event.src, ts: event.ts, code: event.code, severity: event.severity }
    : { src: event.src, ts: event.ts, code: event.code, severity: event.severity, text: event.text };

/**
 * batch_id = UUID v5(시드 : 게이트웨이 : seq : 본문 SHA-256).
 * 같은 실행을 다시 돌리면 같은 id·같은 본문(서버 200 duplicate), 내용이 다르면 다른 id가 된다.
 */
export function buildEnvelope(input: EnvelopeInput): IngestEnvelope {
  const body = {
    schema: INGEST_SCHEMA,
    gateway: input.gateway,
    seq: input.seq,
    sent_at: new Date(input.sentAtMs).toISOString(),
    clock: input.clock,
    series: buildSeries(input.samples),
    events: input.events.map(toIngestEvent),
  } as const;
  const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const batchId = uuidV5(`${input.seed}:${input.gateway}:${input.seq}:${bodyHash}`);
  return {
    schema: body.schema,
    gateway: body.gateway,
    batch_id: batchId,
    seq: body.seq,
    sent_at: body.sent_at,
    clock: body.clock,
    series: body.series,
    events: body.events,
  };
}
