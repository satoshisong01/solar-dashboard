import 'server-only';
import { sql } from 'kysely';
import { CLOSED_STATUSES } from '@/lib/analysis/transition-rules';
import { db } from '@/lib/db/kysely';
import {
  DIAGRAM_CLASS_KEYS,
  DIAGRAM_METRIC_KEYS,
  DIAGRAM_TAG_NAMES,
} from '@/lib/diagram/gapyeong-layout';
import {
  buildDiagram,
  type DiagramAssetInput,
  type DiagramFindingInput,
  type DiagramPointInput,
  type DiagramView,
} from '@/lib/diagram/diagram-view';
import { getSiteByCode, type SiteSummary } from './sites';

export interface SiteDiagram {
  readonly site: SiteSummary;
  readonly view: DiagramView;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * 공정도 한 장이 쓰는 것을 세 번의 조회로 읽는다 (설비 · 포인트+최근 샘플 · 열린 발견사항).
 * 설비마다·포인트마다 따로 묻지 않는다 (N+1 금지): 포인트는 공정도가 실제로 읽는 메트릭·계장 태그로만 좁히고,
 * 최근 샘플은 포인트당 LATERAL 한 번으로 붙인다 (lib/data/points.ts getLatestSamples와 같은 방식).
 */
export async function getSiteDiagram(siteCode: string, nowMs: number): Promise<SiteDiagram | null> {
  const site = await getSiteByCode(siteCode);
  if (!site) return null;

  const classKeys = [...DIAGRAM_CLASS_KEYS];
  const metricKeys = [...DIAGRAM_METRIC_KEYS];
  const tagNames = [...DIAGRAM_TAG_NAMES];
  const closed = [...CLOSED_STATUSES];

  const [assetRows, pointRows, findingRows] = await Promise.all([
    db
      .selectFrom('om.asset as a')
      .innerJoin('om.asset_class as c', 'c.key', 'a.class_key')
      .select(['a.id', 'a.code', 'a.name', 'a.class_key', 'c.name_ko as class_name', 'a.nameplate'])
      .where('a.site_id', '=', site.id)
      .where('a.class_key', 'in', classKeys)
      .orderBy('a.code')
      .execute(),
    sql<{
      id: number;
      asset_code: string;
      metric_key: string;
      qualifier: string;
      unit: string;
      value_kind: string;
      period_s: number | null;
      instrument_tag: string | null;
      ts_ms: number | null;
      value: number | null;
      quality: number | null;
    }>`
      SELECT p.id, a.code AS asset_code, p.metric_key, p.qualifier, m.unit, m.value_kind, p.period_s, p.instrument_tag,
        (extract(epoch FROM l.ts) * 1000)::float8 AS ts_ms, l.value, l.quality
      FROM om.point p
      JOIN om.asset a ON a.id = p.asset_id
      JOIN om.metric_def m ON m.key = p.metric_key
      LEFT JOIN LATERAL (
        SELECT ms.ts, ms.value, ms.quality FROM om.measurement ms
        WHERE ms.point_id = p.id
        ORDER BY ms.ts DESC
        LIMIT 1
      ) l ON true
      WHERE a.site_id = ${site.id}
        AND (p.metric_key = ANY(${metricKeys}::text[]) OR p.instrument_tag = ANY(${tagNames}::text[]))
      ORDER BY a.code, p.metric_key, p.qualifier
    `.execute(db),
    sql<{ id: string; asset_code: string | null; severity: number; category: string; title: string }>`
      SELECT f.id, a.code AS asset_code, f.severity, f.category, f.title
      FROM om.finding f
      LEFT JOIN om.asset a ON a.id = f.asset_id
      WHERE f.site_id = ${site.id} AND f.status <> ALL(${closed})
      ORDER BY f.severity DESC, f.id
    `.execute(db),
  ]);

  const assets: DiagramAssetInput[] = assetRows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    classKey: row.class_key,
    className: row.class_name,
    nameplate: asRecord(row.nameplate),
  }));
  const points: DiagramPointInput[] = pointRows.rows.map((row) => ({
    id: row.id,
    assetCode: row.asset_code,
    metricKey: row.metric_key,
    qualifier: row.qualifier,
    unit: row.unit,
    valueKind: row.value_kind,
    periodS: row.period_s,
    instrumentTag: row.instrument_tag,
    tsMs: row.ts_ms,
    value: row.value,
    quality: row.quality ?? 0,
  }));
  const findings: DiagramFindingInput[] = findingRows.rows.map((row) => ({
    id: row.id,
    assetCode: row.asset_code,
    severity: row.severity,
    category: row.category,
    title: row.title,
  }));

  return { site, view: buildDiagram({ siteCode: site.code, assets, points, findings, nowMs }) };
}
