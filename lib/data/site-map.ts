import 'server-only';
import { sql } from 'kysely';
import { CLOSED_STATUSES } from '@/lib/analysis/transition-rules';
import { db } from '@/lib/db/kysely';
import { getServerEnv } from '@/lib/env';
import { parseEffect } from '@/lib/desk/effect';
import { assetCodeOf } from '@/lib/desk/plain/common';
import { plainHeadline } from '@/lib/desk/plain/headline';
import { SAFETY_FINDING_MIN_SEVERITY } from '@/lib/desk/safety';
import { siteDomainsOf, type SiteDomain } from './domains';
import { mapLevelOf, sortMapSites, type MapLevel } from './map-status';

export interface SiteMapStatus {
  readonly siteId: number;
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly level: MapLevel;
  /** 열린 발견사항 최고 심각도 (없으면 null) */
  readonly worstSeverity: number | null;
  readonly openFindingCount: number;
  /** 카테고리(열화·성능·데이터 품질·안전·가용성) → 건수 */
  readonly categoryCounts: Readonly<Record<string, number>>;
  /** 활성 게이트웨이의 마지막 수신 시각 (없으면 null) */
  readonly lastSeenMs: number | null;
  readonly hasSafetyFinding: boolean;
  readonly domains: readonly SiteDomain[];
  /** 가장 심각한 열린 발견사항을 과제 2의 쉬운 말 한 줄로. 없으면 null */
  readonly worstFinding: WorstFinding | null;
}

export interface WorstFinding {
  readonly id: string;
  readonly severity: number;
  /** lib/desk/plain 의 한 줄 요약 (서버에서 만든다: 클라이언트 번들에 effect 파서를 넣지 않는다) */
  readonly headline: string;
  /** 문장을 누가 썼는가. 저장된 AI 설명이 있으면 llm (여기서 새로 만들지는 않는다) */
  readonly headlineSource: 'llm' | 'template';
}

interface SiteMapRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly open_count: number | null;
  readonly max_severity: number | null;
  readonly safety_count: number | null;
  readonly category_counts: unknown;
  readonly last_seen_ms: number | null;
  readonly class_keys: readonly string[] | null;
  readonly worst_id: string | null;
  readonly worst_severity: number | null;
  readonly worst_title: string | null;
  readonly worst_detector_id: string | null;
  readonly worst_effect: unknown;
  readonly worst_asset_name: string | null;
  readonly worst_asset_path: string | null;
  readonly worst_ai_what: string | null;
}

function categoryCountsOf(raw: unknown): Readonly<Record<string, number>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).flatMap(([key, value]): [string, number][] =>
    typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : [],
  );
  return Object.fromEntries(entries);
}

function worstFindingOf(row: SiteMapRow): WorstFinding | null {
  if (row.worst_id === null || row.worst_detector_id === null || row.worst_severity === null) return null;
  // 저장된 AI 문장이 있으면 그것을 쓴다. 지도에서 모델을 부르지는 않는다 (없으면 틀 문장)
  if (row.worst_ai_what !== null) return { id: row.worst_id, severity: row.worst_severity, headline: row.worst_ai_what, headlineSource: 'llm' };
  return {
    id: row.worst_id,
    severity: row.worst_severity,
    headlineSource: 'template',
    headline: plainHeadline({
      assetName: row.worst_asset_name,
      assetCode: assetCodeOf(row.worst_asset_path),
      siteName: row.name,
      detectorId: row.worst_detector_id,
      effect: parseEffect(row.worst_effect),
      title: row.worst_title ?? '',
    }),
  };
}

/**
 * 지도용 사이트 상태. 사이트마다 LATERAL 서브쿼리로 붙여 한 번의 쿼리로 읽는다 (사이트 수만큼 왕복하지 않는다).
 * 색 판정은 lib/data/map-status.ts 순수 규칙이 하고, 여기서는 신호만 모은다.
 */
export async function getSiteMapStatus(nowMs: number): Promise<readonly SiteMapStatus[]> {
  const silenceMs = getServerEnv().SAFETY_SILENCE_MINUTES * 60_000;
  const closed = [...CLOSED_STATUSES];
  const { rows } = await sql<SiteMapRow>`
    SELECT s.id, s.code, s.name, s.lat, s.lon,
      agg.open_count, agg.max_severity, agg.safety_count, agg.category_counts,
      gw.last_seen_ms, cls.class_keys,
      worst.id AS worst_id, worst.severity AS worst_severity, worst.title AS worst_title,
      worst.detector_id AS worst_detector_id, worst.effect AS worst_effect,
      worst.asset_name AS worst_asset_name, worst.asset_path AS worst_asset_path, ai.what AS worst_ai_what
    FROM om.site s
    LEFT JOIN LATERAL (
      SELECT sum(c.n)::int AS open_count, max(c.max_severity)::int AS max_severity,
        sum(c.safety_n)::int AS safety_count, jsonb_object_agg(c.category, c.n) AS category_counts
      FROM (
        SELECT f.category, count(*)::int AS n, max(f.severity)::int AS max_severity,
          (count(*) FILTER (WHERE f.category = 'safety' AND f.severity >= ${SAFETY_FINDING_MIN_SEVERITY}))::int AS safety_n
        FROM om.finding f
        WHERE f.site_id = s.id AND f.status <> ALL(${closed})
        GROUP BY f.category
      ) c
    ) agg ON true
    LEFT JOIN LATERAL (
      SELECT f.id, f.severity, f.title, f.detector_id, f.effect, f.latest_evidence_id, a.name AS asset_name, a.path AS asset_path
      FROM om.finding f LEFT JOIN om.asset a ON a.id = f.asset_id
      WHERE f.site_id = s.id AND f.status <> ALL(${closed})
      ORDER BY f.severity DESC, f.confidence DESC, f.last_detected_at DESC, f.id DESC
      LIMIT 1
    ) worst ON true
    LEFT JOIN LATERAL (
      SELECT e.text ->> 'what' AS what
      FROM om.finding_explanation e
      WHERE e.finding_id = worst.id AND e.evidence_id = worst.latest_evidence_id AND e.source = 'llm'
    ) ai ON true
    LEFT JOIN LATERAL (
      SELECT (extract(epoch FROM max(g.last_seen_at)) * 1000)::float8 AS last_seen_ms
      FROM om.gateway g WHERE g.site_id = s.id AND g.status = 'active'
    ) gw ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT a.class_key) AS class_keys FROM om.asset a WHERE a.site_id = s.id
    ) cls ON true
    ORDER BY s.code
  `.execute(db);

  return sortMapSites(
    rows.map((row): SiteMapStatus => {
      const signals = {
        openFindingCount: row.open_count ?? 0,
        worstSeverity: row.max_severity,
        hasSafetyFinding: (row.safety_count ?? 0) > 0,
        lastSeenMs: row.last_seen_ms,
      };
      return {
        siteId: row.id,
        code: row.code,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        level: mapLevelOf(signals, nowMs, silenceMs),
        worstSeverity: signals.worstSeverity,
        openFindingCount: signals.openFindingCount,
        categoryCounts: categoryCountsOf(row.category_counts),
        lastSeenMs: signals.lastSeenMs,
        hasSafetyFinding: signals.hasSafetyFinding,
        domains: siteDomainsOf(row.class_keys ?? []),
        worstFinding: worstFindingOf(row),
      };
    }),
  );
}
