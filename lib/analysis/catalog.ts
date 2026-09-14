// 분석 실행 입력 조회: 사이트·설비·포인트·설비 이벤트·탐지기 설정 (Kysely). 판단은 lib/analytics가 한다.
// 'server-only'를 넣지 않는다: 분석 스크립트(npm run analyze)와 integration 테스트에서도 쓴다.
import { sql, type Kysely } from 'kysely';
import type { AssetEventRow, DetectorConfigRow, PipelineAsset } from '@/lib/analytics/pipeline/types';
import type { AssetEventInput } from '@/lib/analytics/detectors/types';
import type { DB } from '@/lib/db/types';

export interface SiteRow {
  readonly id: number;
  readonly code: string;
}

export interface PointRow {
  readonly pointId: number;
  readonly assetId: number;
  readonly metricKey: string;
  readonly sourceKey: string;
  readonly periodS: number | null;
  readonly flatlineMaxS: number | null;
}

const ASSET_EVENT_KINDS: readonly AssetEventInput['kind'][] = ['replacement', 'firmware', 'setpoint_change', 'maintenance', 'calibration', 'other'];
const isEventKind = (kind: string): kind is AssetEventInput['kind'] => (ASSET_EVENT_KINDS as readonly string[]).includes(kind);

const kstDateMs = (date: string | null): number | null => (date === null ? null : Date.parse(`${date}T00:00:00+09:00`));

export async function loadSites(db: Kysely<DB>, siteIds: readonly number[]): Promise<SiteRow[]> {
  if (siteIds.length === 0) return [];
  return db.selectFrom('om.site').select(['id', 'code']).where('id', 'in', [...siteIds]).orderBy('id').execute();
}

export async function loadSiteAssets(db: Kysely<DB>, siteId: number): Promise<PipelineAsset[]> {
  const rows = await db
    .selectFrom('om.asset')
    .select(['id', 'site_id', 'parent_id', 'code', 'class_key', 'peer_group', 'nameplate', sql<string | null>`to_char(commissioned_at, 'YYYY-MM-DD')`.as('commissioned')])
    .where('site_id', '=', siteId)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    parentId: row.parent_id,
    code: row.code,
    classKey: row.class_key,
    peerGroup: row.peer_group,
    nameplate: row.nameplate !== null && typeof row.nameplate === 'object' && !Array.isArray(row.nameplate) ? (row.nameplate as Record<string, unknown>) : {},
    commissionedAt: kstDateMs(row.commissioned),
  }));
}

export async function loadSitePoints(db: Kysely<DB>, siteId: number): Promise<PointRow[]> {
  const rows = await db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .innerJoin('om.metric_def as m', 'm.key', 'p.metric_key')
    .select(['p.id', 'p.asset_id', 'p.metric_key', 'p.qualifier', 'p.source_key', 'p.period_s', 'm.flatline_max_s'])
    .where('a.site_id', '=', siteId)
    .orderBy('p.id')
    .execute();
  // 한정자(qualifier)가 있는 포인트는 같은 메트릭이 여럿이라 에피소드 입력 맵에 넣지 않는다 (데이터 품질 요약에는 쓴다)
  return rows.map((row) => ({ pointId: row.id, assetId: row.asset_id, metricKey: row.qualifier === '' ? row.metric_key : `${row.metric_key}#${row.qualifier}`, sourceKey: row.source_key, periodS: row.period_s, flatlineMaxS: row.flatline_max_s }));
}

export async function loadAssetEvents(db: Kysely<DB>, assetIds: readonly number[], until: Date): Promise<AssetEventRow[]> {
  if (assetIds.length === 0) return [];
  const rows = await db
    .selectFrom('om.asset_event')
    .select(['asset_id', 'ts', 'kind', 'resets_baseline', 'note'])
    .where('asset_id', 'in', [...assetIds])
    .where('ts', '<=', until)
    .orderBy('ts')
    .execute();
  return rows.flatMap((row) => (isEventKind(row.kind) ? [{ assetId: row.asset_id, ts: row.ts.getTime(), kind: row.kind, resetsBaseline: row.resets_baseline, note: row.note }] : []));
}

export async function loadActiveDetectorConfigs(db: Kysely<DB>): Promise<DetectorConfigRow[]> {
  const rows = await db
    .selectFrom('om.detector_config')
    .select([
      'detector_id',
      'scope',
      'version',
      'params',
      sql<number | null>`(extract(epoch FROM lower(reference_window)) * 1000)::float8`.as('ref_start'),
      sql<number | null>`(extract(epoch FROM upper(reference_window)) * 1000)::float8`.as('ref_end'),
    ])
    .where('active', '=', true)
    .execute();
  return rows.map((row) => ({
    detectorId: row.detector_id,
    scope: row.scope,
    version: row.version,
    params: row.params !== null && typeof row.params === 'object' && !Array.isArray(row.params) ? (row.params as Record<string, unknown>) : {},
    referenceWindow: row.ref_start === null || row.ref_end === null ? null : { start: row.ref_start, end: row.ref_end },
  }));
}
