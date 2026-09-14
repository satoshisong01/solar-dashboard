import 'server-only';
import { sql } from 'kysely';
import { isFindingStatus, type FindingStatus } from '@/lib/analysis/transition-rules';
import { VERIFICATION_METRICS } from '@/lib/analytics/verification/before-after';
import { db } from '@/lib/db/kysely';
import { verificationMetricsFor, type VerificationMetricOption } from '@/lib/desk/action-defaults';
import { asArray, asNumber, asRecord, asString } from '@/lib/desk/json-read';

export const ACTION_LIST_LIMIT = 200;

export interface VerificationSummary {
  readonly id: string;
  readonly verdict: string;
  readonly effect: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly unit: string;
  readonly computedAtMs: number;
}

export interface ActionListRow {
  readonly id: string;
  readonly siteCode: string;
  readonly assetId: number;
  readonly assetPath: string;
  readonly actionType: string;
  readonly performedAtMs: number;
  readonly performedBy: string | null;
  readonly source: string;
  readonly finding: Readonly<{ id: string; title: string; status: string }> | null;
  readonly expectedEffect: unknown;
  readonly verification: VerificationSummary | null;
}

interface ActionSqlRow {
  readonly id: string;
  readonly code: string;
  readonly asset_id: number;
  readonly path: string;
  readonly action_type: string;
  readonly performed_at: Date;
  readonly performed_by: string | null;
  readonly source: string;
  readonly expected_effect: unknown;
  readonly finding_id: string | null;
  readonly finding_title: string | null;
  readonly finding_status: string | null;
  readonly v_id: string | null;
  readonly verdict: string | null;
  readonly effect: number | null;
  readonly ci_low: number | null;
  readonly ci_high: number | null;
  readonly before_stats: unknown;
  readonly computed_at: Date | null;
}

const toRow = (r: ActionSqlRow): ActionListRow => ({
  id: r.id,
  siteCode: r.code,
  assetId: r.asset_id,
  assetPath: r.path,
  actionType: r.action_type,
  performedAtMs: r.performed_at.getTime(),
  performedBy: r.performed_by,
  source: r.source,
  finding: r.finding_id !== null ? { id: r.finding_id, title: r.finding_title ?? '', status: r.finding_status ?? '' } : null,
  expectedEffect: r.expected_effect,
  verification: r.v_id !== null && r.verdict !== null && r.computed_at !== null ? { id: r.v_id, verdict: r.verdict, effect: r.effect, ciLow: r.ci_low, ciHigh: r.ci_high, unit: asString(asRecord(r.before_stats).unit) ?? '', computedAtMs: r.computed_at.getTime() } : null,
});

const ACTION_SELECT = sql`
  SELECT m.id, s.code, m.asset_id, a.path, m.action_type, m.performed_at, m.performed_by, m.source, m.expected_effect,
    m.finding_id, f.title AS finding_title, f.status AS finding_status,
    v.id AS v_id, v.verdict, v.effect, v.ci_low, v.ci_high, v.before_stats, v.computed_at
  FROM om.maintenance_action m
  JOIN om.site s ON s.id = m.site_id
  JOIN om.asset a ON a.id = m.asset_id
  LEFT JOIN om.finding f ON f.id = m.finding_id
  LEFT JOIN LATERAL (SELECT * FROM om.action_verification x WHERE x.action_id = m.id ORDER BY x.computed_at DESC, x.id DESC LIMIT 1) v ON true
`;

/** 최근 수행일 순 조치 (사이트 필터 선택) */
export async function listActions(siteCode: string | null): Promise<Readonly<{ rows: readonly ActionListRow[]; truncated: boolean }>> {
  const { rows } = await sql<ActionSqlRow>`${ACTION_SELECT} WHERE (${siteCode}::text IS NULL OR s.code = ${siteCode}) ORDER BY m.performed_at DESC, m.id DESC LIMIT ${ACTION_LIST_LIMIT + 1}`.execute(db);
  return { rows: rows.slice(0, ACTION_LIST_LIMIT).map(toRow), truncated: rows.length > ACTION_LIST_LIMIT };
}

export interface BinStat {
  readonly key: string;
  readonly n: number;
  readonly median: number | null;
}

export interface ActionDetail extends ActionListRow {
  readonly siteId: number;
  readonly siteName: string;
  readonly classKey: string;
  readonly notes: string | null;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly findingDetectorId: string | null;
  readonly detail: Readonly<{ metric: string; metricLabel: string; beforeFrom: number; beforeTo: number; afterFrom: number; afterTo: number; beforeBins: readonly BinStat[]; afterBins: readonly BinStat[]; runId: string }> | null;
}

const bins = (stats: unknown): BinStat[] =>
  asArray(asRecord(stats).bins).flatMap((b) => {
    const key = asString(asRecord(b).key);
    return key === null ? [] : [{ key, n: asNumber(asRecord(b).n) ?? 0, median: asNumber(asRecord(b).median) }];
  });

export async function getActionDetail(actionId: string): Promise<ActionDetail | null> {
  const { rows } = await sql<ActionSqlRow>`${ACTION_SELECT} WHERE m.id = ${actionId}::int8`.execute(db);
  const base = rows[0];
  if (!base) return null;
  const extra = await db
    .selectFrom('om.maintenance_action as m')
    .innerJoin('om.site as s', 's.id', 'm.site_id')
    .innerJoin('om.asset as a', 'a.id', 'm.asset_id')
    .leftJoin('om.finding as f', 'f.id', 'm.finding_id')
    .select(['m.site_id', 's.name', 'a.class_key', 'm.notes', 'm.created_by', 'm.created_at', 'f.detector_id'])
    .where('m.id', '=', actionId)
    .executeTakeFirstOrThrow();
  const verification = base.v_id
    ? await sql<{ metric: string | null; before_from: number; before_to: number; after_from: number; after_to: number; before_stats: unknown; after_stats: unknown; run_id: string }>`
        SELECT before_stats ->> 'metric' AS metric, (extract(epoch FROM lower(before_window)) * 1000)::float8 AS before_from, (extract(epoch FROM upper(before_window)) * 1000)::float8 AS before_to,
          (extract(epoch FROM lower(after_window)) * 1000)::float8 AS after_from, (extract(epoch FROM upper(after_window)) * 1000)::float8 AS after_to, before_stats, after_stats, run_id
        FROM om.action_verification WHERE id = ${base.v_id}::int8
      `.execute(db)
    : null;
  const v = verification?.rows[0];
  return {
    ...toRow(base),
    siteId: extra.site_id,
    siteName: extra.name,
    classKey: extra.class_key,
    notes: extra.notes,
    createdBy: extra.created_by,
    createdAtMs: extra.created_at.getTime(),
    findingDetectorId: extra.detector_id,
    detail: v ? { metric: v.metric ?? '', metricLabel: VERIFICATION_METRICS[v.metric ?? '']?.label ?? v.metric ?? '', beforeFrom: v.before_from, beforeTo: v.before_to, afterFrom: v.after_from, afterTo: v.after_to, beforeBins: bins(v.before_stats), afterBins: bins(v.after_stats), runId: v.run_id } : null,
  };
}

export interface ActionFormSite {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

export interface ActionFormAsset {
  readonly id: number;
  readonly siteId: number;
  readonly path: string;
  readonly name: string;
  readonly metrics: readonly VerificationMetricOption[];
}

export interface ActionFormFinding {
  readonly id: string;
  readonly siteId: number;
  readonly assetId: number | null;
  readonly title: string;
  readonly detectorId: string;
  readonly status: FindingStatus;
}

export interface ActionFormOptions {
  readonly sites: readonly ActionFormSite[];
  readonly assets: readonly ActionFormAsset[];
  /** 조치를 연결할 수 있는 열린 발견사항 */
  readonly findings: readonly ActionFormFinding[];
}

export async function getActionFormOptions(): Promise<ActionFormOptions> {
  const [sites, assets, findings] = await Promise.all([
    db.selectFrom('om.site').select(['id', 'code', 'name']).orderBy('code').execute(),
    db.selectFrom('om.asset').select(['id', 'site_id', 'path', 'name', 'class_key']).orderBy('path').execute(),
    db.selectFrom('om.finding').select(['id', 'site_id', 'asset_id', 'title', 'detector_id', 'status']).where('status', 'not in', ['verified', 'dismissed']).where('asset_id', 'is not', null).orderBy('id', 'desc').limit(500).execute(),
  ]);
  return {
    sites,
    assets: assets.map((a) => ({ id: a.id, siteId: a.site_id, path: a.path, name: a.name, metrics: verificationMetricsFor(a.class_key) })),
    findings: findings.flatMap((f) => (isFindingStatus(f.status) ? [{ id: f.id, siteId: f.site_id, assetId: f.asset_id, title: f.title, detectorId: f.detector_id, status: f.status }] : [])),
  };
}
