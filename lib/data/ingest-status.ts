import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { DAY_MS } from './time';

export interface GatewayIngestRow {
  readonly id: number;
  readonly code: string;
  readonly siteCode: string;
  readonly status: string;
  readonly lastSeenMs: number | null;
  readonly clockOffsetMs: number | null;
  readonly activeKeys: number;
  /** 최근 24시간에 새로 저장된 배치 (같은 batch_id 재전송은 새 배치로 저장되지 않아 세지 않는다) */
  readonly batches24h: number;
  readonly samples24h: number;
  readonly accepted24h: number;
  /** 이미 있던 (포인트, 시각) 샘플 */
  readonly duplicate24h: number;
  /** 미래 +5분 초과·2000년 이전 등으로 거부한 샘플 */
  readonly rejected24h: number;
  readonly unmapped24h: number;
}

/** 게이트웨이별 수신 상태와 최근 24시간(수신 시각 기준) 배치 통계 */
export async function getGatewayIngestStatus(nowMs: number): Promise<readonly GatewayIngestRow[]> {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { rows } = await sql<{
    id: number;
    code: string;
    site_code: string;
    status: string;
    last_seen_ms: number | null;
    clock_offset_ms: number | null;
    active_keys: number;
    batches: number;
    samples: number;
    accepted: number;
    duplicate: number;
    rejected: number;
    unmapped: number;
  }>`
    SELECT g.id, g.code, s.code AS site_code, g.status,
      (extract(epoch FROM g.last_seen_at) * 1000)::float8 AS last_seen_ms, g.clock_offset_ms,
      (SELECT count(*) FROM om.gateway_key k WHERE k.gateway_id = g.id AND k.revoked_at IS NULL)::int AS active_keys,
      count(b.id)::int AS batches,
      COALESCE(sum(b.n_samples), 0)::float8 AS samples,
      COALESCE(sum(b.n_accepted), 0)::float8 AS accepted,
      COALESCE(sum(b.n_duplicate), 0)::float8 AS duplicate,
      COALESCE(sum(b.n_rejected), 0)::float8 AS rejected,
      COALESCE(sum(b.n_unmapped), 0)::float8 AS unmapped
    FROM om.gateway g
    JOIN om.site s ON s.id = g.site_id
    LEFT JOIN om.ingest_batch b ON b.gateway_id = g.id AND b.received_at >= ${since}::timestamptz
    GROUP BY g.id, s.code
    ORDER BY s.code, g.code
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    siteCode: row.site_code,
    status: row.status,
    lastSeenMs: row.last_seen_ms,
    clockOffsetMs: row.clock_offset_ms,
    activeKeys: row.active_keys,
    batches24h: row.batches,
    samples24h: row.samples,
    accepted24h: row.accepted,
    duplicate24h: row.duplicate,
    rejected24h: row.rejected,
    unmapped24h: row.unmapped,
  }));
}

export interface InboxTag {
  readonly gatewayId: number;
  readonly gatewayCode: string;
  readonly siteId: number;
  readonly siteCode: string;
  readonly sourceKey: string;
  readonly unit: string | null;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly sampleCount: number;
  /** 포인트가 이미 만들어졌으면 그 포인트 (재처리 대기) */
  readonly mapped: Readonly<{ pointId: number; assetId: number; assetCode: string; metricKey: string; qualifier: string }> | null;
}

function inboxQuery() {
  return db
    .selectFrom('om.unmapped_source as u')
    .innerJoin('om.gateway as g', 'g.id', 'u.gateway_id')
    .innerJoin('om.site as s', 's.id', 'g.site_id')
    .leftJoin('om.point as p', (join) => join.onRef('p.gateway_id', '=', 'u.gateway_id').onRef('p.source_key', '=', 'u.source_key'))
    .leftJoin('om.asset as a', 'a.id', 'p.asset_id')
    .select([
      'u.gateway_id',
      'g.code as gateway_code',
      'g.site_id',
      's.code as site_code',
      'u.source_key',
      'u.unit',
      'u.first_seen_at',
      'u.last_seen_at',
      'u.sample_count',
      'p.id as point_id',
      'p.asset_id',
      'a.code as asset_code',
      'p.metric_key',
      'p.qualifier',
    ]);
}

type InboxDbRow = Awaited<ReturnType<ReturnType<typeof inboxQuery>['execute']>>[number];

const toInboxTag = (row: InboxDbRow): InboxTag => ({
  gatewayId: row.gateway_id,
  gatewayCode: row.gateway_code,
  siteId: row.site_id,
  siteCode: row.site_code,
  sourceKey: row.source_key,
  unit: row.unit,
  firstSeenMs: row.first_seen_at.getTime(),
  lastSeenMs: row.last_seen_at.getTime(),
  sampleCount: Number(row.sample_count),
  mapped:
    row.point_id !== null && row.asset_id !== null && row.asset_code !== null && row.metric_key !== null
      ? { pointId: row.point_id, assetId: row.asset_id, assetCode: row.asset_code, metricKey: row.metric_key, qualifier: row.qualifier ?? '' }
      : null,
});

/** 미매핑 인박스 전체 (매핑됐지만 재처리 전인 태그 포함). 사이트 → 게이트웨이 → 태그 순 */
export async function getUnmappedInbox(): Promise<readonly InboxTag[]> {
  const rows = await inboxQuery().orderBy('s.code').orderBy('g.code').orderBy('u.source_key').execute();
  return rows.map(toInboxTag);
}

export async function getInboxTag(gatewayId: number, sourceKey: string): Promise<InboxTag | null> {
  const row = await inboxQuery().where('u.gateway_id', '=', gatewayId).where('u.source_key', '=', sourceKey).executeTakeFirst();
  return row ? toInboxTag(row) : null;
}
