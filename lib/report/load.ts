// 리포트 팩 입력 조회 (Kysely, I/O). 판단은 evidence-pack.ts·planner.ts(순수)가 한다.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 관리자 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import { ENERGY_KPI_KEYS, ENERGY_KPIS, computeEnergy, ratedPerHour, sumNullable, type HourBucket } from '@/lib/data/energy-calc';
import { ALLOC_VERSION, type SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { kstDayStart } from '@/lib/analytics/types';
import { parseLedgerRow, type LedgerDbRow } from '@/lib/chain/parse';
import type { DB } from '@/lib/db/types';
import type { FindingInput, PackInput } from './evidence-pack';
import type { KpiRowInput, MarketRowInput, VerificationInput } from './pack-sections';
import type { PackEnergy, PackPeriod } from './pack-types';
import { kstDay } from './period';

const HOUR_MS = 3_600_000;

export class ReportError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface ReportRequest {
  readonly siteId: number;
  readonly period: PackPeriod;
  readonly findingIds: readonly string[];
  readonly includeVerifiedActions: boolean;
  /** 새 초안 만들기의 바탕 리포트 (없으면 null) */
  readonly basedOnReportId?: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

async function loadFindings(db: Kysely<DB>, siteId: number, ids: readonly string[]): Promise<FindingInput[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('om.finding as f')
    .leftJoin('om.asset as a', 'a.id', 'f.asset_id')
    .leftJoin('om.finding_evidence as e', 'e.id', 'f.latest_evidence_id')
    .select(['f.id', 'f.asset_id', 'a.path', 'a.criticality', 'f.detector_id', 'f.detector_version', 'f.failure_mode', 'f.category', 'f.title', 'f.severity', 'f.confidence', 'f.status', 'f.effect'])
    .select(['f.window_start', 'f.window_end', 'f.first_detected_at', 'f.last_detected_at', 'f.detection_count', 'f.previous_finding_id', 'e.id as evidence_id', 'e.computed_at as evidence_at', 'e.snapshot'])
    .where('f.site_id', '=', siteId)
    .where('f.id', 'in', [...ids])
    .execute();
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    throw new ReportError('invalid', `이 사이트의 발견사항이 아닙니다: ${ids.filter((id) => !found.has(id)).join(', ')}`);
  }
  const [transitions, actions] = await Promise.all([
    db.selectFrom('om.finding_transition').select(['finding_id', 'from_status', 'to_status', 'actor', 'at']).where('finding_id', 'in', [...ids]).orderBy('at').orderBy('id').execute(),
    db.selectFrom('om.maintenance_action').select(['id', 'finding_id', 'action_type', 'performed_at']).where('finding_id', 'in', [...ids]).orderBy('performed_at').orderBy('id').execute(),
  ]);
  return rows.map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    assetPath: row.path,
    assetCriticality: row.criticality,
    detectorId: row.detector_id,
    detectorVersion: row.detector_version,
    failureMode: row.failure_mode,
    category: row.category,
    title: row.title,
    severity: row.severity,
    confidence: row.confidence,
    status: row.status,
    effect: row.effect,
    windowStart: row.window_start.getTime(),
    windowEnd: row.window_end.getTime(),
    firstDetectedAt: row.first_detected_at.getTime(),
    lastDetectedAt: row.last_detected_at.getTime(),
    detectionCount: row.detection_count,
    previousFindingId: row.previous_finding_id,
    evidenceId: row.evidence_id,
    evidenceComputedAt: row.evidence_at ? row.evidence_at.getTime() : null,
    snapshot: row.snapshot,
    transitions: transitions.filter((t) => t.finding_id === row.id).map((t) => ({ from: t.from_status, to: t.to_status, at: t.at.getTime(), actor: t.actor })),
    actions: actions.filter((a) => a.finding_id === row.id).map((a) => ({ id: a.id, actionType: a.action_type, performedAt: a.performed_at.getTime() })),
  }));
}

/** 일 KPI는 끝난 날만: 기간 끝과 오늘 0시(KST) 중 이른 쪽 전날까지 (진행 중인 오늘은 완결성이 낮게 나와 데이터 품질 요청을 잘못 만든다) */
async function loadKpiRows(db: Kysely<DB>, siteId: number, period: PackPeriod, now: Date): Promise<KpiRowInput[]> {
  const endDay = kstDay(Math.min(period.to, kstDayStart(now.getTime())));
  const { rows } = await sql<{ scope_type: string; path: string | null; day: string; kpi_key: string; value: number | null; dq_completeness: number | null }>`
    SELECT k.scope_type, a.path, to_char(k.day, 'YYYY-MM-DD') AS day, k.kpi_key, k.value, k.dq_completeness
    FROM om.kpi_daily k
    LEFT JOIN om.asset a ON k.scope_type = 'asset' AND a.id = k.scope_id
    WHERE ((k.scope_type = 'site' AND k.scope_id = ${siteId}) OR (k.scope_type = 'asset' AND a.site_id = ${siteId}))
      AND k.day >= ${kstDay(period.from)}::date AND k.day < ${endDay}::date
    ORDER BY k.kpi_key, a.path, k.day
  `.execute(db);
  return rows.map((row) => ({ scopeType: row.scope_type === 'site' ? 'site' : 'asset', assetPath: row.path, day: row.day, key: row.kpi_key, value: row.value, dqCompleteness: row.dq_completeness }));
}

/** 사이트 발전·수소 요약 (m_1h, 대시보드와 같은 정의). 기간 끝은 지금을 넘지 않는다 */
async function loadEnergy(db: Kysely<DB>, siteId: number, window: { fromMs: number; toMs: number }): Promise<PackEnergy> {
  const points = await db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .select(['p.id', 'a.class_key', 'a.nameplate', 'p.metric_key'])
    .where('a.site_id', '=', siteId)
    .where((eb) => eb.or(ENERGY_KPI_KEYS.map((key) => eb.and([eb('a.class_key', '=', ENERGY_KPIS[key].classKey), eb('p.metric_key', '=', ENERGY_KPIS[key].metricKey)]))))
    .execute();
  const empty: PackEnergy = { pvKwh: null, essChargeKwh: null, essDischargeKwh: null, h2Kg: null, fcKwh: null };
  if (points.length === 0 || window.toMs <= window.fromMs) return empty;
  const { rows } = await sql<{ point_id: number; bucket_ms: number; v_first: number | null; v_last: number | null; v_avg: number | null }>`
    SELECT point_id, (extract(epoch FROM bucket) * 1000)::float8 AS bucket_ms, v_first, v_last, v_avg
    FROM om.m_1h
    WHERE point_id = ANY(${points.map((p) => p.id)}::int4[]) AND bucket >= ${iso(window.fromMs - HOUR_MS)}::timestamptz AND bucket < ${iso(window.toMs)}::timestamptz
  `.execute(db);
  const buckets = (pointId: number): HourBucket[] => rows.filter((r) => r.point_id === pointId).map((r) => ({ bucketMs: r.bucket_ms, first: r.v_first, last: r.v_last, avg: r.v_avg }));
  const valueOf = (key: (typeof ENERGY_KPI_KEYS)[number]) =>
    sumNullable(
      points
        .filter((p) => p.class_key === ENERGY_KPIS[key].classKey && p.metric_key === ENERGY_KPIS[key].metricKey)
        .map((p) => computeEnergy(ENERGY_KPIS[key].method, buckets(p.id), window, ratedPerHour(p.nameplate, key)).value),
    );
  return { pvKwh: valueOf('pvKwh'), essChargeKwh: valueOf('essChargeKwh'), essDischargeKwh: valueOf('essDischargeKwh'), h2Kg: valueOf('h2Kg'), fcKwh: valueOf('fcKwh') };
}

/** 기간 안에 계산됐거나 후 창이 기간 안에서 끝난 조치 효과 검증 */
async function loadVerifications(db: Kysely<DB>, siteId: number, period: PackPeriod): Promise<VerificationInput[]> {
  const { rows } = await sql<{
    id: string;
    action_id: string;
    finding_id: string | null;
    path: string;
    action_type: string;
    performed_at: Date;
    verdict: string;
    effect: number | null;
    ci_low: number | null;
    ci_high: number | null;
    before_stats: unknown;
    after_stats: unknown;
    computed_at: Date;
  }>`
    SELECT v.id, v.action_id, m.finding_id, a.path, m.action_type, m.performed_at, v.verdict, v.effect, v.ci_low, v.ci_high, v.before_stats, v.after_stats, v.computed_at
    FROM om.action_verification v
    JOIN om.maintenance_action m ON m.id = v.action_id
    JOIN om.asset a ON a.id = m.asset_id
    WHERE m.site_id = ${siteId}
      AND ((v.computed_at >= ${iso(period.from)}::timestamptz AND v.computed_at < ${iso(period.to)}::timestamptz)
        OR (upper(v.after_window) > ${iso(period.from)}::timestamptz AND upper(v.after_window) <= ${iso(period.to)}::timestamptz))
    ORDER BY m.performed_at, v.id
  `.execute(db);
  return rows.map((r) => ({ id: r.id, actionId: r.action_id, findingId: r.finding_id, assetPath: r.path, actionType: r.action_type, performedAt: r.performed_at.getTime(), verdict: r.verdict, effect: r.effect, ciLow: r.ci_low, ciHigh: r.ci_high, beforeStats: r.before_stats, afterStats: r.after_stats, computedAt: r.computed_at.getTime() }));
}

/** 체인 원장 일 행: 기간 안의 끝난 날만 (기간 끝과 오늘 0시(KST) 중 이른 쪽 전날까지, 원장은 하루가 끝난 날만 저장된다) */
async function loadLedgerDays(db: Kysely<DB>, siteId: number, period: PackPeriod, now: Date): Promise<SiteEnergyDay[]> {
  const endDay = kstDay(Math.min(period.to, kstDayStart(now.getTime())));
  const { rows } = await sql<LedgerDbRow>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, flows_kwh, energy_kwh, h2_kg, elz_grid_share, renewable_share, elz_sec_kwh_per_kg, fc_kg_per_mwh, p2p_efficiency, pv_loss_kwh, dq, calc_version
    FROM om.site_energy_daily
    WHERE site_id = ${siteId} AND alloc_version = ${ALLOC_VERSION} AND day >= ${kstDay(period.from)}::date AND day < ${endDay}::date
    ORDER BY day
  `.execute(db);
  return rows.map(parseLedgerRow);
}

async function loadMarket(db: Kysely<DB>, period: PackPeriod): Promise<MarketRowInput[]> {
  const { rows } = await sql<{ day: string; market_key: string; value: number; unit: string }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, market_key, value::float8 AS value, unit
    FROM om.market_daily
    WHERE day >= ${kstDay(period.from)}::date AND day < ${kstDay(period.to)}::date
    ORDER BY market_key, day
  `.execute(db);
  return rows.map((row) => ({ day: row.day, key: row.market_key, value: row.value, unit: row.unit }));
}

export async function loadPackInput(db: Kysely<DB>, request: ReportRequest, now: Date): Promise<PackInput> {
  const site = await db.selectFrom('om.site').select(['id', 'code', 'name']).where('id', '=', request.siteId).executeTakeFirst();
  if (!site) throw new ReportError('not_found', '사이트를 찾을 수 없습니다');
  const ids = [...new Set(request.findingIds)];
  const [findings, kpiRows, energy, verifications, market, ledgerDays] = await Promise.all([
    loadFindings(db, site.id, ids),
    loadKpiRows(db, site.id, request.period, now),
    loadEnergy(db, site.id, { fromMs: request.period.from, toMs: Math.min(request.period.to, now.getTime()) }),
    request.includeVerifiedActions ? loadVerifications(db, site.id, request.period) : Promise.resolve([]),
    loadMarket(db, request.period),
    loadLedgerDays(db, site.id, request.period, now),
  ]);
  return { site: { id: site.id, code: site.code, name: site.name }, period: request.period, selection: { findingIds: ids, includeVerifiedActions: request.includeVerifiedActions, basedOnReportId: request.basedOnReportId ?? null }, generatedAt: now.getTime(), findings, kpiRows, energy, verifications, market, ledgerDays };
}
