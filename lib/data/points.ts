import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { INVALID_QUALITY_MASK } from './quality';

export interface PointInfo {
  readonly id: number;
  readonly assetId: number;
  readonly assetCode: string;
  readonly assetName: string;
  readonly classKey: string;
  readonly siteCode: string;
  readonly metricKey: string;
  readonly metricName: string;
  readonly qualifier: string;
  readonly unit: string;
  readonly valueKind: string;
  readonly sourceKey: string;
  readonly periodS: number | null;
}

interface PointFilter {
  readonly assetId?: number;
  readonly pointIds?: readonly number[];
  readonly siteCode?: string;
}

/** 포인트와 설비·사이트·메트릭 정보. 사이트 → 설비 코드 → 메트릭 순 */
export async function getPoints(filter: PointFilter = {}): Promise<readonly PointInfo[]> {
  let query = db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .innerJoin('om.site as s', 's.id', 'a.site_id')
    .innerJoin('om.metric_def as m', 'm.key', 'p.metric_key')
    .select([
      'p.id',
      'p.asset_id',
      'a.code as asset_code',
      'a.name as asset_name',
      'a.class_key',
      's.code as site_code',
      'p.metric_key',
      'm.name_ko as metric_name',
      'p.qualifier',
      'm.unit',
      'm.value_kind',
      'p.source_key',
      'p.period_s',
    ])
    .orderBy('s.code')
    .orderBy('a.code')
    .orderBy('p.metric_key')
    .orderBy('p.qualifier');

  if (filter.assetId !== undefined) query = query.where('p.asset_id', '=', filter.assetId);
  if (filter.siteCode !== undefined) query = query.where('s.code', '=', filter.siteCode);
  if (filter.pointIds !== undefined) {
    if (filter.pointIds.length === 0) return [];
    query = query.where('p.id', 'in', [...filter.pointIds]);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    classKey: row.class_key,
    siteCode: row.site_code,
    metricKey: row.metric_key,
    metricName: row.metric_name,
    qualifier: row.qualifier,
    unit: row.unit,
    valueKind: row.value_kind,
    sourceKey: row.source_key,
    periodS: row.period_s,
  }));
}

export interface LatestSample {
  readonly pointId: number;
  readonly tsMs: number;
  readonly value: number | null;
  readonly quality: number;
}

/** 포인트별 가장 최근 원시 샘플 (PK 역순 인덱스 탐색). 수신 기록이 없는 포인트는 빠진다 */
export async function getLatestSamples(pointIds: readonly number[]): Promise<ReadonlyMap<number, LatestSample>> {
  if (pointIds.length === 0) return new Map();
  const { rows } = await sql<{ point_id: number; ts_ms: number; value: number | null; quality: number }>`
    SELECT p.id AS point_id, (extract(epoch FROM l.ts) * 1000)::float8 AS ts_ms, l.value, l.quality
    FROM unnest(${[...pointIds]}::int4[]) AS p(id)
    CROSS JOIN LATERAL (
      SELECT m.ts, m.value, m.quality FROM om.measurement m
      WHERE m.point_id = p.id
      ORDER BY m.ts DESC
      LIMIT 1
    ) l
  `.execute(db);
  return new Map(rows.map((row) => [row.point_id, { pointId: row.point_id, tsMs: row.ts_ms, value: row.value, quality: row.quality }]));
}

export interface QualitySummary {
  readonly samples: number;
  readonly invalid: number;
  /** 구간 샘플에 한 번이라도 켜진 비트의 OR */
  readonly bitsSeen: number;
}

/** 포인트별 구간 샘플 수·유효성 비트 샘플 수·켜진 비트 */
export async function getQualitySummary(
  pointIds: readonly number[],
  fromMs: number,
  toMs: number,
): Promise<ReadonlyMap<number, QualitySummary>> {
  if (pointIds.length === 0) return new Map();
  const { rows } = await sql<{ point_id: number; samples: number; invalid: number; bits_seen: number }>`
    SELECT point_id,
      count(*)::int AS samples,
      (count(*) FILTER (WHERE quality & ${INVALID_QUALITY_MASK} <> 0))::int AS invalid,
      bit_or(quality)::int AS bits_seen
    FROM om.measurement
    WHERE point_id = ANY(${[...pointIds]}::int4[])
      AND ts >= ${new Date(fromMs).toISOString()}::timestamptz AND ts < ${new Date(toMs).toISOString()}::timestamptz
    GROUP BY point_id
  `.execute(db);
  return new Map(rows.map((row) => [row.point_id, { samples: row.samples, invalid: row.invalid, bitsSeen: row.bits_seen }]));
}
