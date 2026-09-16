import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { kstDateString, MS_PER_DAY } from '@/lib/analytics/types';
import { massBalanceThreshold } from './chain';
import { FLEET_COLUMNS, domainOfClass, domainOfSiteDetector, type FleetColumn } from './domains';
import { getOpenFindingGroups, type OpenFindingGroup } from './findings';
import { FLEET_THRESHOLDS, evaluateCell, LEDGER_RESIDUAL_RULES, summarizeLedgerResidual, worstLevel, type CellSignals, type CellStatus, type LedgerDayResidual, type LedgerResidual, type StatusLevel } from './fleet-status';
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
  /** 사이트×설비 종류별 가장 최근 원시 샘플 시각. 수신 기록이 없는 조합은 빠진다 */
  readonly lastSample: readonly (SiteClassRow & { readonly ts_ms: number })[];
  readonly events: readonly Readonly<{ site_id: number; class_key: string | null; is_safety: boolean; severity: string; n: number }>[];
  readonly quality: readonly (SiteClassRow & { readonly samples: number; readonly invalid: number })[];
  readonly findings: readonly OpenFindingGroup[];
  /** 사이트 id → 수소 원장 잔차율 요약 (원장이 없거나 판단할 날이 모자라면 없음) */
  readonly ledger: ReadonlyMap<number, LedgerResidual>;
}

/** 원장이 이 일수보다 오래 멈췄으면 플릿 신호로 쓰지 않는다 (최근 원장만) */
const LEDGER_LOOKBACK_DAYS = 14;

async function loadLedgerResiduals(nowMs: number): Promise<ReadonlyMap<number, LedgerResidual>> {
  const [threshold, result] = await Promise.all([
    massBalanceThreshold(),
    sql<{ site_id: number; day: string; residual_pct: number | null; completeness: number | null }>`
      SELECT site_id, to_char(day, 'YYYY-MM-DD') AS day, (h2_kg ->> 'residual_pct')::float8 AS residual_pct, (dq -> 'h2' ->> 'completeness')::float8 AS completeness
      FROM om.site_energy_daily
      WHERE day >= ${kstDateString(nowMs - LEDGER_LOOKBACK_DAYS * MS_PER_DAY)}::date AND day < ${kstDateString(nowMs)}::date
    `.execute(db),
  ]);
  const bySite = result.rows.reduce((map, row) => map.set(row.site_id, [...(map.get(row.site_id) ?? []), { day: row.day, residualPct: row.residual_pct, completeness: row.completeness }]), new Map<number, LedgerDayResidual[]>());
  return new Map(
    [...bySite.entries()].flatMap(([siteId, days]) => {
      const summary = summarizeLedgerResidual(days, { thresholdPct: threshold.residualPct, minCompleteness: threshold.minCompleteness }, LEDGER_RESIDUAL_RULES.recentDays, LEDGER_RESIDUAL_RULES.minDays);
      return summary === null ? [] : [[siteId, summary] as const];
    }),
  );
}

async function loadInputs(nowMs: number): Promise<FleetInputs> {
  const since = new Date(nowMs - FLEET_THRESHOLDS.alarmWindowMs).toISOString();
  const [sites, classes, lastSample, events, quality, findings, ledger] = await Promise.all([
    db.selectFrom('om.site').select(['id', 'code', 'name', 'lat', 'lon']).orderBy('code').execute(),
    db.selectFrom('om.asset').select(['site_id', 'class_key']).distinct().execute(),
    // 신선도는 셀(사이트×설비 종류) 단위로만 쓰므로 포인트별 최근 샘플을 DB에서 바로 합친다.
    // 포인트 id를 먼저 받아 두 번째 쿼리에 넘기던 것을 없애 왕복 한 번과 438행 전송이 사라진다.
    sql<FleetInputs['lastSample'][number]>`
      SELECT a.site_id, a.class_key, (extract(epoch FROM max(l.ts)) * 1000)::float8 AS ts_ms
      FROM om.point p
      JOIN om.asset a ON a.id = p.asset_id
      CROSS JOIN LATERAL (
        SELECT m.ts FROM om.measurement m WHERE m.point_id = p.id ORDER BY m.ts DESC LIMIT 1
      ) l
      GROUP BY a.site_id, a.class_key
    `.execute(db),
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
    getOpenFindingGroups(),
    loadLedgerResiduals(nowMs),
  ]);
  return { sites, classes, lastSample: lastSample.rows, events: events.rows, quality: quality.rows, findings, ledger };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const maxOrNull = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.max(...values));

/** 도메인 열은 그 도메인 설비만, 데이터품질 열은 사이트의 모든 설비(신선도·품질 비율만)를 본다 */
function signalsFor(inputs: FleetInputs, siteId: number, column: FleetColumn): CellSignals {
  const inColumn = (row: Readonly<{ site_id: number; class_key: string | null }>) =>
    row.site_id === siteId && row.class_key !== null && (column === 'dq' || domainOfClass(row.class_key) === column);

  const quality = inputs.quality.filter(inColumn);
  const events = column === 'dq' ? [] : inputs.events.filter(inColumn);
  const count = (predicate: (row: FleetInputs['events'][number]) => boolean) => sum(events.filter(predicate).map((row) => row.n));

  return {
    hasAssets: inputs.classes.some(inColumn),
    lastSampleMs: maxOrNull(inputs.lastSample.filter(inColumn).map((row) => row.ts_ms)),
    majorAlarms24h: count((row) => !row.is_safety && row.severity === 'major'),
    criticalAlarms24h: count((row) => !row.is_safety && row.severity === 'critical'),
    unackedSafety: count((row) => row.is_safety),
    samples24h: sum(quality.map((row) => row.samples)),
    invalidSamples24h: sum(quality.map((row) => row.invalid)),
    ...findingSignals(inputs.findings, siteId, column),
    // 수소 원장 잔차는 저장 열에 (사이트 단위 물질수지 발견사항과 같은 열: lib/data/domains.ts domainOfSiteDetector)
    ledgerResidual: column === 'storage' ? (inputs.ledger.get(siteId) ?? null) : null,
  };
}

/** 발견사항 그룹의 열: 데이터 품질 카테고리는 데이터품질 열, 설비가 있으면 설비 종류의 도메인, 사이트 단위는 탐지기로 정한 도메인 (오염 → PV, 물질수지 → 저장) */
function columnOfGroup(g: OpenFindingGroup): FleetColumn | null {
  if (g.category === 'data_quality') return 'dq';
  if (g.classKey !== null) return domainOfClass(g.classKey);
  return g.siteDetectorId === null ? null : domainOfSiteDetector(g.siteDetectorId);
}

function findingSignals(groups: readonly OpenFindingGroup[], siteId: number, column: FleetColumn): Pick<CellSignals, 'openFindings' | 'maxFindingSeverity' | 'safetyFindings'> {
  const inCell = groups.filter((g) => g.siteId === siteId && columnOfGroup(g) === column);
  return { openFindings: sum(inCell.map((g) => g.count)), maxFindingSeverity: inCell.length === 0 ? null : Math.max(...inCell.map((g) => g.maxSeverity)), safetyFindings: sum(inCell.map((g) => g.safetyCount)) };
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
