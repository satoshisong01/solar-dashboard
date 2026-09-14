import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { FLEET_COLUMNS, domainOfClass, type FleetColumn } from './domains';
import { FLEET_THRESHOLDS, evaluateCell, worstLevel, type CellSignals, type CellStatus, type StatusLevel } from './fleet-status';
import { getLatestSamples, type LatestSample } from './points';
import { INVALID_QUALITY_MASK } from './quality';

export interface FleetSite {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
}

export interface FleetRow {
  readonly site: FleetSite;
  readonly cells: Readonly<Record<FleetColumn, CellStatus>>;
  /** 설비와 연결되지 않은 것까지 포함한 사이트 전체 미확인 안전 이벤트 */
  readonly unackedSafety: number;
  readonly overall: StatusLevel;
}

interface SiteClassRow {
  readonly site_id: number;
  readonly class_key: string;
}

interface FleetInputs {
  readonly sites: readonly FleetSite[];
  readonly classes: readonly SiteClassRow[];
  readonly points: readonly (SiteClassRow & { readonly id: number })[];
  readonly latest: ReadonlyMap<number, LatestSample>;
  readonly events: readonly Readonly<{ site_id: number; class_key: string | null; is_safety: boolean; severity: string; n: number }>[];
  readonly quality: readonly (SiteClassRow & { readonly samples: number; readonly invalid: number })[];
}

async function loadInputs(nowMs: number): Promise<FleetInputs> {
  const since = new Date(nowMs - FLEET_THRESHOLDS.alarmWindowMs).toISOString();
  const [sites, classes, points, events, quality] = await Promise.all([
    db.selectFrom('om.site').select(['id', 'code', 'name', 'lat', 'lon']).orderBy('code').execute(),
    db.selectFrom('om.asset').select(['site_id', 'class_key']).distinct().execute(),
    db.selectFrom('om.point as p').innerJoin('om.asset as a', 'a.id', 'p.asset_id').select(['p.id', 'a.site_id', 'a.class_key']).execute(),
    sql<FleetInputs['events'][number]>`
      SELECT e.site_id, a.class_key, e.is_safety, e.severity, count(*)::int AS n
      FROM om.event_log e LEFT JOIN om.asset a ON a.id = e.asset_id
      WHERE (e.is_safety AND e.acked_at IS NULL)
         OR (NOT e.is_safety AND e.severity IN ('major', 'critical') AND e.ts >= ${since}::timestamptz)
      GROUP BY e.site_id, a.class_key, e.is_safety, e.severity
    `.execute(db),
    sql<FleetInputs['quality'][number]>`
      SELECT a.site_id, a.class_key, count(*)::int AS samples,
        (count(*) FILTER (WHERE m.quality & ${INVALID_QUALITY_MASK} <> 0))::int AS invalid
      FROM om.measurement m
      JOIN om.point p ON p.id = m.point_id
      JOIN om.asset a ON a.id = p.asset_id
      WHERE m.ts >= ${since}::timestamptz
      GROUP BY a.site_id, a.class_key
    `.execute(db),
  ]);
  const latest = await getLatestSamples(points.map((p) => p.id));
  return { sites, classes, points, latest, events: events.rows, quality: quality.rows };
}

const maxNullable = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** 도메인 열은 그 도메인 설비만, 데이터품질 열은 사이트의 모든 설비(신선도·품질 비율만)를 본다 */
function signalsFor(inputs: FleetInputs, siteId: number, column: FleetColumn): CellSignals {
  const inColumn = (row: Readonly<{ site_id: number; class_key: string | null }>) =>
    row.site_id === siteId && row.class_key !== null && (column === 'dq' || domainOfClass(row.class_key) === column);

  const quality = inputs.quality.filter(inColumn);
  const events = column === 'dq' ? [] : inputs.events.filter(inColumn);
  const count = (predicate: (row: FleetInputs['events'][number]) => boolean) => sum(events.filter(predicate).map((row) => row.n));

  return {
    hasAssets: inputs.classes.some(inColumn),
    lastSampleMs: inputs.points
      .filter(inColumn)
      .map((point) => inputs.latest.get(point.id)?.tsMs ?? null)
      .reduce(maxNullable, null),
    majorAlarms24h: count((row) => !row.is_safety && row.severity === 'major'),
    criticalAlarms24h: count((row) => !row.is_safety && row.severity === 'critical'),
    unackedSafety: count((row) => row.is_safety),
    samples24h: sum(quality.map((row) => row.samples)),
    invalidSamples24h: sum(quality.map((row) => row.invalid)),
  };
}

/** 플릿 매트릭스: 셀 상태는 lib/data/fleet-status.ts 규칙으로 계산한다 */
export async function getFleetMatrix(nowMs: number): Promise<readonly FleetRow[]> {
  const inputs = await loadInputs(nowMs);

  return inputs.sites.map((site) => {
    const cells = Object.fromEntries(
      FLEET_COLUMNS.map((column) => [column.key, evaluateCell(signalsFor(inputs, site.id, column.key), nowMs)]),
    ) as Record<FleetColumn, CellStatus>;
    const unackedSafety = sum(inputs.events.filter((row) => row.site_id === site.id && row.is_safety).map((row) => row.n));
    const overall = worstLevel([...Object.values(cells).map((cell) => cell.level), unackedSafety > 0 ? 'crit' : 'na']);
    return { site, cells, unackedSafety, overall };
  });
}
