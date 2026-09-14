import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { QUALITY, type QualityFlag } from '@/lib/ingest/quality';
import { INVALID_QUALITY_MASK } from './quality';

const FLAGS = Object.keys(QUALITY) as QualityFlag[];
const toIso = (ms: number) => new Date(ms).toISOString();

export interface PointLabel {
  readonly pointId: number;
  readonly siteCode: string;
  readonly assetId: number;
  readonly assetCode: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly qualifier: string;
  readonly unit: string;
}

export interface PointQualityRow extends PointLabel {
  readonly samples: number;
  /** 유효성 비트(INVALID_QUALITY_MASK)가 하나라도 켜진 샘플 */
  readonly invalid: number;
  /** 비트별 샘플 수 (QUALITY 정의 순서) */
  readonly bitCounts: Readonly<Record<QualityFlag, number>>;
}

export type QualityScope = 'invalid' | 'any';

export interface PointQualityResult {
  /** 조건에 맞는 포인트 전체 수 (rows는 limit까지) */
  readonly total: number;
  readonly rows: readonly PointQualityRow[];
}

const LABEL_COLUMNS = sql`
  p.id AS point_id, s.code AS site_code, a.id AS asset_id, a.code AS asset_code,
  p.metric_key, d.name_ko AS metric_name, p.qualifier, d.unit
`;

type LabelDbRow = {
  point_id: number;
  site_code: string;
  asset_id: number;
  asset_code: string;
  metric_key: string;
  metric_name: string;
  qualifier: string;
  unit: string;
};

const toLabel = (row: LabelDbRow): PointLabel => ({
  pointId: row.point_id,
  siteCode: row.site_code,
  assetId: row.asset_id,
  assetCode: row.asset_code,
  metricKey: row.metric_key,
  metricName: row.metric_name,
  qualifier: row.qualifier,
  unit: row.unit,
});

/**
 * 포인트별 구간 샘플의 품질 비트 비율. scope=invalid면 유효성 비트가 있는 포인트만, any면 비트가 하나라도 있는 포인트.
 * 유효성 이상 비율이 높은 순.
 */
export async function getPointQuality(fromMs: number, toMs: number, scope: QualityScope, limit: number): Promise<PointQualityResult> {
  const mask = scope === 'invalid' ? INVALID_QUALITY_MASK : FLAGS.reduce((all, flag) => all | QUALITY[flag], 0);
  const bitColumns = sql.join(FLAGS.map((flag) => sql`(count(*) FILTER (WHERE m.quality & ${QUALITY[flag]} <> 0))::int`));
  const { rows } = await sql<LabelDbRow & { samples: number; invalid: number; bit_counts: number[]; total: number }>`
    WITH agg AS (
      SELECT m.point_id, count(*)::int AS samples,
        (count(*) FILTER (WHERE m.quality & ${INVALID_QUALITY_MASK} <> 0))::int AS invalid,
        ARRAY[${bitColumns}]::int[] AS bit_counts
      FROM om.measurement m
      WHERE m.ts >= ${toIso(fromMs)}::timestamptz AND m.ts < ${toIso(toMs)}::timestamptz
      GROUP BY m.point_id
      HAVING bit_or(m.quality) & ${mask} <> 0
    )
    SELECT ${LABEL_COLUMNS}, agg.samples, agg.invalid, agg.bit_counts, count(*) OVER ()::int AS total
    FROM agg
    JOIN om.point p ON p.id = agg.point_id
    JOIN om.asset a ON a.id = p.asset_id
    JOIN om.site s ON s.id = a.site_id
    JOIN om.metric_def d ON d.key = p.metric_key
    ORDER BY agg.invalid::float8 / agg.samples DESC, agg.samples DESC, p.id
    LIMIT ${limit}
  `.execute(db);

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((row) => ({
      ...toLabel(row),
      samples: row.samples,
      invalid: row.invalid,
      bitCounts: Object.fromEntries(FLAGS.map((flag, index) => [flag, row.bit_counts[index] ?? 0])) as Record<QualityFlag, number>,
    })),
  };
}

export interface StuckPointRow extends PointLabel {
  readonly lastValue: number;
  readonly lastTsMs: number;
  /** 같은 값이 시작된 시각 (구간 안에서 본 첫 샘플) */
  readonly runStartMs: number;
  /** 구간 첫 샘플부터 값이 그대로면 true (실제 시작은 구간 전일 수 있다) */
  readonly wholeWindow: boolean;
  readonly samples: number;
  /** metric_def.flatline_max_s (고착 판정 기준). 없으면 null */
  readonly flatlineMaxS: number | null;
}

export interface StuckQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly minMinutes: number;
  /** false면 마지막 값이 정확히 0인 포인트(야간 정지 등)를 뺀다 */
  readonly includeZero: boolean;
  readonly limit: number;
}

/**
 * gauge 포인트 중 구간 안의 마지막 값이 minMinutes 이상 바뀌지 않은 포인트 (고착 의심).
 * 값이 바뀐 마지막 샘플(lag 비교) 이후 같은 값이 이어진 길이로 판정한다. 오래 이어진 순.
 */
export async function getStuckPoints(query: StuckQuery): Promise<readonly StuckPointRow[]> {
  const { rows } = await sql<LabelDbRow & { last_value: number; last_ts_ms: number; run_start_ms: number; first_ts_ms: number; samples: number; flatline_max_s: number | null }>`
    WITH recent AS (
      SELECT m.point_id, m.ts, m.value,
        m.value IS DISTINCT FROM lag(m.value) OVER (PARTITION BY m.point_id ORDER BY m.ts) AS changed
      FROM om.measurement m
      JOIN om.point p ON p.id = m.point_id
      JOIN om.metric_def d ON d.key = p.metric_key
      WHERE d.value_kind = 'gauge' AND m.value IS NOT NULL
        AND m.ts >= ${toIso(query.fromMs)}::timestamptz AND m.ts < ${toIso(query.toMs)}::timestamptz
    ),
    runs AS (
      SELECT point_id, count(*)::int AS samples, min(ts) AS first_ts, max(ts) AS last_ts,
        max(ts) FILTER (WHERE changed) AS run_start,
        (array_agg(value ORDER BY ts DESC))[1] AS last_value
      FROM recent
      GROUP BY point_id
    )
    SELECT ${LABEL_COLUMNS}, r.samples, r.last_value, d.flatline_max_s,
      (extract(epoch FROM r.last_ts) * 1000)::float8 AS last_ts_ms,
      (extract(epoch FROM r.run_start) * 1000)::float8 AS run_start_ms,
      (extract(epoch FROM r.first_ts) * 1000)::float8 AS first_ts_ms
    FROM runs r
    JOIN om.point p ON p.id = r.point_id
    JOIN om.asset a ON a.id = p.asset_id
    JOIN om.site s ON s.id = a.site_id
    JOIN om.metric_def d ON d.key = p.metric_key
    WHERE r.last_ts - r.run_start >= make_interval(mins => ${query.minMinutes})
      AND (${query.includeZero}::boolean OR r.last_value <> 0)
    ORDER BY r.last_ts - r.run_start DESC, p.id
    LIMIT ${query.limit}
  `.execute(db);

  return rows.map((row) => ({
    ...toLabel(row),
    lastValue: row.last_value,
    lastTsMs: row.last_ts_ms,
    runStartMs: row.run_start_ms,
    wholeWindow: row.run_start_ms === row.first_ts_ms,
    samples: row.samples,
    flatlineMaxS: row.flatline_max_s,
  }));
}
