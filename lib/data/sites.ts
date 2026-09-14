import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { toSeverity, type EventSeverity } from './severity';

export interface SiteSummary {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly timezone: string;
  readonly layout: string | null;
  readonly controlGroup: boolean;
  readonly simulated: boolean;
}

export interface SiteListRow extends SiteSummary {
  readonly assetCount: number;
  readonly pointCount: number;
  readonly gatewayCount: number;
  readonly lastSeenMs: number | null;
  readonly unackedSafety: number;
}

interface SiteDbRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly timezone: string;
  readonly attributes: unknown;
}

function readAttributes(attributes: unknown): Pick<SiteSummary, 'layout' | 'controlGroup' | 'simulated'> {
  const record = typeof attributes === 'object' && attributes !== null ? (attributes as Record<string, unknown>) : {};
  return {
    layout: typeof record.layout === 'string' ? record.layout : null,
    controlGroup: record.control_group === true,
    simulated: record.simulated === true,
  };
}

const toSummary = (row: SiteDbRow): SiteSummary => ({
  id: row.id,
  code: row.code,
  name: row.name,
  lat: row.lat,
  lon: row.lon,
  timezone: row.timezone,
  ...readAttributes(row.attributes),
});

export const SITE_LAYOUT_LABELS: Readonly<Record<string, string>> = {
  pv_ess: '태양광 + ESS',
  integrated: '연계형 (태양광 · ESS · 수소 · 연료전지)',
};

export async function listSites(): Promise<readonly SiteListRow[]> {
  const { rows } = await sql<SiteDbRow & {
    asset_count: number;
    point_count: number;
    gateway_count: number;
    last_seen_ms: number | null;
    unacked_safety: number;
  }>`
    SELECT s.id, s.code, s.name, s.lat, s.lon, s.timezone, s.attributes,
      (SELECT count(*) FROM om.asset a WHERE a.site_id = s.id)::int AS asset_count,
      (SELECT count(*) FROM om.point p JOIN om.asset a ON a.id = p.asset_id WHERE a.site_id = s.id)::int AS point_count,
      (SELECT count(*) FROM om.gateway g WHERE g.site_id = s.id)::int AS gateway_count,
      (SELECT (extract(epoch FROM max(g.last_seen_at)) * 1000)::float8 FROM om.gateway g WHERE g.site_id = s.id) AS last_seen_ms,
      (SELECT count(*) FROM om.event_log e WHERE e.site_id = s.id AND e.is_safety AND e.acked_at IS NULL)::int AS unacked_safety
    FROM om.site s
    ORDER BY s.code
  `.execute(db);

  return rows.map((row) => ({
    ...toSummary(row),
    assetCount: row.asset_count,
    pointCount: row.point_count,
    gatewayCount: row.gateway_count,
    lastSeenMs: row.last_seen_ms,
    unackedSafety: row.unacked_safety,
  }));
}

export async function getSiteByCode(code: string): Promise<SiteSummary | null> {
  const row = await db
    .selectFrom('om.site')
    .select(['id', 'code', 'name', 'lat', 'lon', 'timezone', 'attributes'])
    .where('code', '=', code)
    .executeTakeFirst();
  return row ? toSummary(row) : null;
}

export interface SiteAssetRow {
  readonly id: number;
  readonly siteCode: string;
  readonly parentId: number | null;
  readonly code: string;
  readonly name: string;
  readonly level: string;
  readonly classKey: string;
  readonly className: string;
  readonly pointCount: number;
}

/** 설비 목록 (siteId를 주면 그 사이트만). 사이트 → 설비 코드 순 */
export async function getAssets(filter: Readonly<{ siteId?: number }> = {}): Promise<readonly SiteAssetRow[]> {
  let query = db
    .selectFrom('om.asset as a')
    .innerJoin('om.asset_class as c', 'c.key', 'a.class_key')
    .innerJoin('om.site as s', 's.id', 'a.site_id')
    .select((eb) => [
      'a.id',
      's.code as site_code',
      'a.parent_id',
      'a.code',
      'a.name',
      'a.level',
      'a.class_key',
      'c.name_ko',
      eb
        .selectFrom('om.point as p')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('p.asset_id', '=', 'a.id')
        .as('point_count'),
    ])
    .orderBy('s.code')
    .orderBy('a.code');
  if (filter.siteId !== undefined) query = query.where('a.site_id', '=', filter.siteId);

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    siteCode: row.site_code,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    level: row.level,
    classKey: row.class_key,
    className: row.name_ko,
    pointCount: row.point_count ?? 0,
  }));
}

export interface EventRow {
  readonly id: string;
  readonly tsMs: number;
  readonly siteCode: string;
  readonly assetId: number | null;
  readonly assetCode: string | null;
  readonly assetName: string | null;
  readonly sourceKey: string;
  readonly code: string;
  readonly severity: EventSeverity;
  readonly isSafety: boolean;
  readonly text: string | null;
  readonly ackedAtMs: number | null;
}

interface EventFilter {
  readonly siteId?: number;
  readonly assetIds?: readonly number[];
  readonly fromMs?: number;
  readonly toMs?: number;
  /** 확인(ack)되지 않은 안전 이벤트만 */
  readonly unackedSafetyOnly?: boolean;
  readonly limit: number;
}

/** 최근 이벤트부터 (사이트·설비·기간 필터) */
export async function getEvents(filter: EventFilter): Promise<readonly EventRow[]> {
  let query = db
    .selectFrom('om.event_log as e')
    .innerJoin('om.site as s', 's.id', 'e.site_id')
    .leftJoin('om.asset as a', 'a.id', 'e.asset_id')
    .select([
      'e.id',
      'e.ts',
      's.code as site_code',
      'e.asset_id',
      'a.code as asset_code',
      'a.name as asset_name',
      'e.source_key',
      'e.code',
      'e.severity',
      'e.is_safety',
      'e.text',
      'e.acked_at',
    ])
    .orderBy('e.ts', 'desc')
    .orderBy('e.id', 'desc')
    .limit(filter.limit);

  if (filter.siteId !== undefined) query = query.where('e.site_id', '=', filter.siteId);
  if (filter.assetIds !== undefined) {
    if (filter.assetIds.length === 0) return [];
    query = query.where('e.asset_id', 'in', [...filter.assetIds]);
  }
  if (filter.fromMs !== undefined) query = query.where('e.ts', '>=', new Date(filter.fromMs));
  if (filter.toMs !== undefined) query = query.where('e.ts', '<', new Date(filter.toMs));
  if (filter.unackedSafetyOnly) query = query.where('e.is_safety', '=', true).where('e.acked_at', 'is', null);

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    tsMs: row.ts.getTime(),
    siteCode: row.site_code,
    assetId: row.asset_id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    sourceKey: row.source_key,
    code: row.code,
    severity: toSeverity(row.severity),
    isSafety: row.is_safety,
    text: row.text,
    ackedAtMs: row.acked_at ? row.acked_at.getTime() : null,
  }));
}

export interface GatewayRow {
  readonly id: number;
  readonly code: string;
  readonly status: string;
  readonly lastSeenMs: number | null;
  readonly lastSeq: string | null;
  readonly clockOffsetMs: number | null;
  readonly activeKeys: number;
}

export async function getSiteGateways(siteId: number): Promise<readonly GatewayRow[]> {
  const rows = await db
    .selectFrom('om.gateway as g')
    .select((eb) => [
      'g.id',
      'g.code',
      'g.status',
      'g.last_seen_at',
      'g.last_seq',
      'g.clock_offset_ms',
      eb
        .selectFrom('om.gateway_key as k')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('k.gateway_id', '=', 'g.id')
        .where('k.revoked_at', 'is', null)
        .as('active_keys'),
    ])
    .where('g.site_id', '=', siteId)
    .orderBy('g.code')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    lastSeenMs: row.last_seen_at ? row.last_seen_at.getTime() : null,
    lastSeq: row.last_seq,
    clockOffsetMs: row.clock_offset_ms,
    activeKeys: row.active_keys ?? 0,
  }));
}
