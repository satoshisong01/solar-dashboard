// 정규화한 배치를 DB에 기록한다 (설계 §5.1 규칙 3·5·8, §5.2). 대량 INSERT는 unnest 배열 파라미터 한 번으로 한다.
// 'server-only'를 넣지 않는다: 재처리 스크립트와 테스트에서도 쓴다.
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { IngestEnvelope } from './envelope';
import type { EventContext, NormalizedBatch, NormalizedEvent, NormalizedSample, PointMapping, UnmappedSeries } from './normalize';
import { sourceKeyPrefixes } from './normalize';

type Executor = Kysely<DB> | Transaction<DB>;

const INT32_MAX = 2_147_483_647;
const clampInt32 = (value: number) => Math.max(-INT32_MAX, Math.min(INT32_MAX, Math.round(value)));
const toIso = (ms: number) => new Date(ms).toISOString();

/** 배치에 나온 태그의 포인트 매핑과 메트릭 hard 범위 */
export async function loadPointMappings(db: Executor, gatewayId: number, sourceKeys: readonly string[]): Promise<ReadonlyMap<string, PointMapping>> {
  if (sourceKeys.length === 0) return new Map();
  const rows = await db
    .selectFrom('om.point as p')
    .innerJoin('om.metric_def as m', 'm.key', 'p.metric_key')
    .select(['p.id', 'p.source_key', 'p.scale', 'p.value_offset', 'm.hard_min', 'm.hard_max'])
    .where('p.gateway_id', '=', gatewayId)
    .where('p.source_key', 'in', [...new Set(sourceKeys)])
    .execute();
  return new Map(
    rows.map((row) => [
      row.source_key,
      { pointId: row.id, scale: row.scale, valueOffset: row.value_offset, hardMin: row.hard_min, hardMax: row.hard_max },
    ]),
  );
}

/** 이벤트 태그 접두어에 해당하는 사이트 설비와 안전 이벤트 코드 */
export async function loadEventContext(db: Executor, siteId: number, eventSourceKeys: readonly string[]): Promise<EventContext> {
  if (eventSourceKeys.length === 0) return { assetsByCode: new Map(), allSafetyEventCodes: new Set() };
  const prefixes = [...new Set(eventSourceKeys.flatMap(sourceKeyPrefixes))];
  const assets = await db
    .selectFrom('om.asset as a')
    .innerJoin('om.asset_class as c', 'c.key', 'a.class_key')
    .select(['a.id', 'a.code', 'c.safety_event_codes'])
    .where('a.site_id', '=', siteId)
    .where('a.code', 'in', prefixes)
    .execute();
  const classes = await db.selectFrom('om.asset_class').select('safety_event_codes').execute();
  return {
    assetsByCode: new Map(assets.map((asset) => [asset.code, { assetId: asset.id, safetyEventCodes: asset.safety_event_codes }])),
    allSafetyEventCodes: new Set(classes.flatMap((row) => row.safety_event_codes)),
  };
}

/** 샘플 시각이 속한 UTC 월(YYYY-MM-01)들 */
export function monthsOf(timestampsMs: readonly number[]): readonly string[] {
  const months = new Set(timestampsMs.map((ms) => `${new Date(ms).toISOString().slice(0, 7)}-01`));
  return [...months].sort();
}

interface PartitionPlan {
  readonly name: string;
  readonly ensure: (trx: Transaction<DB>) => Promise<number>;
}

function partitionPlans(months: readonly string[]): readonly PartitionPlan[] {
  const monthly = months.map((month) => ({
    name: `measurement_y${month.slice(0, 4)}m${month.slice(5, 7)}`,
    ensure: (trx: Transaction<DB>) => callEnsure(trx, sql`om.ensure_measurement_partitions(${month}::date, 1)`),
  }));
  const yearly = [...new Set(months.map((month) => month.slice(0, 4)))].map((year) => ({
    name: `m_1h_y${year}`,
    ensure: (trx: Transaction<DB>) => callEnsure(trx, sql`om.ensure_m1h_partitions(${`${year}-01-01`}::date, 1)`),
  }));
  return [...monthly, ...yearly];
}

async function callEnsure(trx: Transaction<DB>, call: RawBuilder<unknown>): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT ${call} AS n`.execute(trx);
  return rows[0]?.n ?? 0;
}

/**
 * 샘플이 들어갈 measurement 월 파티션과 m_1h 연 파티션이 없으면 만든다 (없으면 DEFAULT에 쌓인다). 만든 개수를 돌려준다.
 * 수집 트랜잭션 밖에서 먼저 호출한다: 파티션 부착은 DEFAULT 파티션을 배타 잠금하므로 짧은 별도 트랜잭션에서 끝낸다.
 * 동시 요청은 advisory lock으로 직렬화하고, ensure 함수가 이미 있는 파티션은 건너뛴다.
 */
export async function ensurePartitionsFor(db: Kysely<DB>, timestampsMs: readonly number[]): Promise<number> {
  const plans = partitionPlans(monthsOf(timestampsMs));
  if (plans.length === 0) return 0;
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM unnest(${plans.map((plan) => plan.name)}::text[]) AS name
    WHERE to_regclass('om.' || quote_ident(name)) IS NULL
  `.execute(db);
  const missing = new Set(rows.map((row) => row.name));
  if (missing.size === 0) return 0;

  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('om.ensure_partitions'))`.execute(trx);
    let created = 0;
    for (const plan of plans.filter((item) => missing.has(item.name))) {
      created += await plan.ensure(trx);
    }
    return created;
  });
}

export interface InsertSamplesResult {
  readonly inserted: number;
  /** 실제로 삽입돼 dirty 표시된 포인트 */
  readonly pointIds: readonly number[];
}

/**
 * 원시 INSERT … ON CONFLICT DO NOTHING RETURNING → 삽입된 (point, UTC 시간)만 rollup_dirty upsert(gen+1).
 * 겹치는 샘플을 가진 배치가 동시에 들어와도 교착이 생기지 않도록 행을 키 순서로 넣는다.
 */
export async function insertSamples(db: Executor, samples: readonly NormalizedSample[]): Promise<InsertSamplesResult> {
  if (samples.length === 0) return { inserted: 0, pointIds: [] };
  const { rows } = await sql<{ inserted: number; point_ids: number[] }>`
    WITH ins AS (
      INSERT INTO om.measurement (point_id, ts, value, quality)
      SELECT * FROM unnest(
        ${samples.map((s) => s.pointId)}::int4[],
        ${samples.map((s) => toIso(s.tsMs))}::timestamptz[],
        ${samples.map((s) => s.value)}::float8[],
        ${samples.map((s) => s.quality)}::int2[]
      ) AS t(point_id, ts, value, quality)
      ORDER BY point_id, ts
      ON CONFLICT (point_id, ts) DO NOTHING
      RETURNING point_id, ts
    ),
    dirty AS (
      INSERT INTO om.rollup_dirty AS d (point_id, bucket)
      SELECT DISTINCT point_id, date_trunc('hour', ts, 'UTC') AS bucket FROM ins
      ORDER BY point_id, bucket
      ON CONFLICT (point_id, bucket) DO UPDATE SET gen = d.gen + 1, touched_at = now()
      RETURNING point_id
    )
    SELECT
      (SELECT count(*) FROM ins)::int AS inserted,
      COALESCE((SELECT array_agg(DISTINCT point_id ORDER BY point_id) FROM dirty), '{}')::int4[] AS point_ids
  `.execute(db);
  const [row] = rows;
  return { inserted: row?.inserted ?? 0, pointIds: row?.point_ids ?? [] };
}

async function upsertUnmapped(trx: Transaction<DB>, gatewayId: number, unmapped: readonly UnmappedSeries[], receivedAt: string): Promise<void> {
  if (unmapped.length === 0) return;
  await sql`
    INSERT INTO om.unmapped_source AS u (gateway_id, source_key, unit, first_seen_at, last_seen_at, sample_count)
    SELECT ${gatewayId}, t.source_key, t.unit, ${receivedAt}::timestamptz, ${receivedAt}::timestamptz, t.n
    FROM unnest(${unmapped.map((u) => u.sourceKey)}::text[], ${unmapped.map((u) => u.unit)}::text[], ${unmapped.map((u) => u.sampleCount)}::int8[])
      AS t(source_key, unit, n)
    ORDER BY t.source_key
    ON CONFLICT (gateway_id, source_key) DO UPDATE SET
      unit = excluded.unit,
      last_seen_at = GREATEST(u.last_seen_at, excluded.last_seen_at),
      sample_count = u.sample_count + excluded.sample_count
  `.execute(trx);
}

/** 이벤트를 기록한다. 같은 (게이트웨이, 태그, 시각, 코드)는 한 번만 들어가고 확인(ack) 정보는 건드리지 않는다. */
async function insertEvents(trx: Transaction<DB>, siteId: number, gatewayId: number, events: readonly NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const { rows } = await sql<{ inserted: number }>`
    WITH ins AS (
      INSERT INTO om.event_log (site_id, gateway_id, asset_id, ts, source_key, code, severity, is_safety, text)
      SELECT ${siteId}, ${gatewayId}, t.asset_id, t.ts, t.source_key, t.code, t.severity, t.is_safety, t.text
      FROM unnest(
        ${events.map((e) => e.assetId)}::int4[],
        ${events.map((e) => toIso(e.tsMs))}::timestamptz[],
        ${events.map((e) => e.sourceKey)}::text[],
        ${events.map((e) => e.code)}::text[],
        ${events.map((e) => e.severity)}::text[],
        ${events.map((e) => e.isSafety)}::bool[],
        ${events.map((e) => e.text)}::text[]
      ) AS t(asset_id, ts, source_key, code, severity, is_safety, text)
      ORDER BY t.source_key, t.ts, t.code
      ON CONFLICT (gateway_id, source_key, ts, code) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS inserted FROM ins
  `.execute(trx);
  return rows[0]?.inserted ?? 0;
}

export interface IngestCounts {
  readonly accepted: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly unmapped: number;
  readonly missing: number;
  readonly events: number;
}

export interface StoreBatchInput {
  readonly gatewayId: number;
  readonly siteId: number;
  readonly envelope: IngestEnvelope;
  readonly bodyGzip: Uint8Array;
  /** 압축을 푼 JSON 본문의 SHA-256 (같은 batch_id 재전송 판별) */
  readonly bodySha256: Uint8Array;
  readonly receivedAtMs: number;
  readonly normalized: NormalizedBatch;
  readonly events: readonly NormalizedEvent[];
}

export type StoreBatchResult =
  | { readonly kind: 'stored'; readonly counts: IngestCounts; readonly pointIds: readonly number[] }
  | { readonly kind: 'duplicate'; readonly counts: IngestCounts }
  | { readonly kind: 'conflict' };

type BatchClaim = { readonly kind: 'claimed'; readonly id: string } | Exclude<StoreBatchResult, { kind: 'stored' }>;

/** (gateway, batch_id)를 선점한다. 이미 있으면 본문 해시로 duplicate/conflict를 가린다. */
async function claimBatch(trx: Transaction<DB>, input: StoreBatchInput): Promise<BatchClaim> {
  const { envelope, normalized } = input;
  const inserted = await trx
    .insertInto('om.ingest_batch')
    .values({
      gateway_id: input.gatewayId,
      batch_id: envelope.batch_id,
      seq: envelope.seq,
      sent_at: envelope.sent_at,
      received_at: new Date(input.receivedAtMs),
      skew_ms: clampInt32(normalized.skewMs),
      body_sha256: Buffer.from(input.bodySha256),
      body_gzip: Buffer.from(input.bodyGzip),
      n_samples: normalized.stats.total,
      status: 'normalized',
    })
    .onConflict((oc) => oc.columns(['gateway_id', 'batch_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { kind: 'claimed', id: inserted.id };

  const existing = await trx
    .selectFrom('om.ingest_batch')
    .select(['body_sha256', 'n_samples'])
    .where('gateway_id', '=', input.gatewayId)
    .where('batch_id', '=', envelope.batch_id)
    .executeTakeFirstOrThrow();
  if (!existing.body_sha256.equals(Buffer.from(input.bodySha256))) return { kind: 'conflict' };
  return { kind: 'duplicate', counts: { accepted: 0, duplicate: existing.n_samples, rejected: 0, unmapped: 0, missing: 0, events: 0 } };
}

/**
 * 한 트랜잭션: 배치 선점 → 원시 + rollup_dirty → 미매핑 인박스 → 이벤트(안전 즉시 기록) → 게이트웨이 상태 → 배치 통계.
 * 파티션은 호출 전에 ensurePartitionsFor로 준비한다.
 */
export async function storeBatch(db: Kysely<DB>, input: StoreBatchInput): Promise<StoreBatchResult> {
  return db.transaction().execute(async (trx) => {
    const claim = await claimBatch(trx, input);
    if (claim.kind !== 'claimed') return claim;

    const { normalized } = input;
    const receivedAt = toIso(input.receivedAtMs);
    const samples = await insertSamples(trx, normalized.samples);
    await upsertUnmapped(trx, input.gatewayId, normalized.unmapped, receivedAt);
    const events = await insertEvents(trx, input.siteId, input.gatewayId, input.events);

    await sql`
      UPDATE om.gateway SET
        last_seen_at = GREATEST(COALESCE(last_seen_at, ${receivedAt}::timestamptz), ${receivedAt}::timestamptz),
        last_seq = GREATEST(COALESCE(last_seq, ${input.envelope.seq}::int8), ${input.envelope.seq}::int8),
        clock_offset_ms = ${clampInt32(normalized.skewMs)}
      WHERE id = ${input.gatewayId}
    `.execute(trx);

    const counts: IngestCounts = {
      accepted: samples.inserted,
      duplicate: normalized.stats.candidates - samples.inserted,
      rejected: normalized.stats.rejected,
      unmapped: normalized.stats.unmapped,
      missing: normalized.stats.missing,
      events,
    };
    await trx
      .updateTable('om.ingest_batch')
      .set({
        n_accepted: counts.accepted,
        n_duplicate: counts.duplicate,
        n_rejected: counts.rejected,
        n_unmapped: counts.unmapped,
        n_events: counts.events,
        status: counts.rejected > 0 || counts.unmapped > 0 ? 'partial' : 'normalized',
      })
      .where('id', '=', claim.id)
      .execute();

    return { kind: 'stored', counts, pointIds: samples.pointIds };
  });
}
