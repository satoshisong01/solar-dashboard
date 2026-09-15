import 'server-only';
// 탐지 준비도 화면·CSV 조회: 사이트 설비·포인트 + 최근 30일 1시간 롤업 수집 통계 → lib/analytics/readiness 순수 판정.
import { sql } from 'kysely';
import { loadSiteAssets } from '@/lib/analysis/catalog';
import { DETECTORS } from '@/lib/analytics/detectors';
import {
  metricAcquisitionRanking,
  pointStatOf,
  readinessSummary,
  requirementsFromDetectors,
  SITE_ROW_CLASS,
  siteReadinessRows,
  withRelatedDetectors,
  type AcquisitionView,
  type ReadinessRow,
  type ReadinessSummary,
} from '@/lib/analytics/readiness';
import { db } from '@/lib/db/kysely';
import type { SiteSummary } from './sites';

/** 완결성을 보는 최근 창 [일] (lib/analytics/readiness/types.ts ReadinessPoint 규칙) */
export const READINESS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

interface CountRow {
  readonly asset_id: number;
  readonly metric_key: string;
  readonly qualifier: string;
  readonly period_s: number | null;
  readonly first_ms: number | null;
  readonly n_good: number | null;
  readonly n: number | null;
  readonly hours: number;
}

export interface ReadinessView {
  readonly rows: readonly (ReadinessRow & { readonly className: string })[];
  readonly summary: ReadinessSummary;
  readonly ranking: readonly (AcquisitionView & { readonly metricName: string | null })[];
  readonly pointCount: number;
  readonly nowMs: number;
}

/** 포인트별 첫 롤업 버킷(기본키 인덱스 1행)과 최근 창 good·전체 샘플 수 */
async function loadPointCounts(siteId: number, nowMs: number): Promise<readonly CountRow[]> {
  const from = new Date(nowMs - READINESS_WINDOW_DAYS * DAY_MS).toISOString();
  const to = new Date(nowMs).toISOString();
  const { rows } = await sql<CountRow>`
    SELECT p.asset_id, p.metric_key, p.qualifier, p.period_s,
      (SELECT extract(epoch FROM m.bucket) * 1000 FROM om.m_1h m WHERE m.point_id = p.id ORDER BY m.bucket LIMIT 1)::float8 AS first_ms,
      w.n_good, w.n, w.hours
    FROM om.point p
    JOIN om.asset a ON a.id = p.asset_id
    LEFT JOIN LATERAL (
      SELECT sum(m.n_good)::float8 AS n_good, sum(m.n)::float8 AS n, count(*)::int AS hours
      FROM om.m_1h m
      WHERE m.point_id = p.id AND m.bucket >= ${from}::timestamptz AND m.bucket < ${to}::timestamptz
    ) w ON true
    WHERE a.site_id = ${siteId}
    ORDER BY p.id
  `.execute(db);
  return rows;
}

async function loadNames(): Promise<{ readonly classes: ReadonlyMap<string, string>; readonly metrics: ReadonlyMap<string, string> }> {
  const [classes, metrics] = await Promise.all([db.selectFrom('om.asset_class').select(['key', 'name_ko']).execute(), db.selectFrom('om.metric_def').select(['key', 'name_ko']).execute()]);
  return { classes: new Map(classes.map((c) => [c.key, c.name_ko])), metrics: new Map(metrics.map((m) => [m.key, m.name_ko])) };
}

export async function getSiteReadiness(site: Pick<SiteSummary, 'id'>, nowMs: number): Promise<ReadinessView> {
  const [assets, counts, names] = await Promise.all([loadSiteAssets(db, site.id), loadPointCounts(site.id, nowMs), loadNames()]);
  const stats = counts.map((row) =>
    pointStatOf(
      {
        assetId: row.asset_id,
        metricKey: row.qualifier === '' ? row.metric_key : `${row.metric_key}#${row.qualifier}`,
        periodS: row.period_s,
        firstMs: row.first_ms,
        nGood: row.n_good ?? 0,
        n: row.n ?? 0,
        hours: row.hours,
      },
      nowMs,
      READINESS_WINDOW_DAYS,
    ),
  );
  const rows = siteReadinessRows(assets, stats, requirementsFromDetectors(DETECTORS));
  const cells = rows.flatMap((r) => r.cells);
  return {
    rows: rows.map((r) => ({ ...r, className: names.classes.get(r.classKey) ?? (r.classKey === SITE_ROW_CLASS ? '사이트 단위 탐지기' : r.classKey) })),
    summary: readinessSummary(cells),
    ranking: withRelatedDetectors(metricAcquisitionRanking(cells), cells).map((r) => ({ ...r, metricName: names.metrics.get(r.metricKey) ?? null })),
    pointCount: counts.length,
    nowMs,
  };
}
