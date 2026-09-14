import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { BUCKET_ORIGIN_ISO, chooseBucket, type SeriesPayload, type SeriesQuery, type SeriesRow } from './series-types';

interface BucketRow {
  readonly point_id: number;
  readonly t: number;
  readonly v_min: number | null;
  readonly v_avg: number | null;
  readonly v_max: number | null;
}

/**
 * 버킷별 최소·평균·최대. 48시간 이하는 원시(measurement)를 date_bin으로 묶고,
 * 넘으면 1시간 롤업(m_1h)을 묶는다(평균은 시간 평균들의 평균). 경계는 KST 자정 기준.
 */
export async function getSeries(query: SeriesQuery): Promise<SeriesPayload> {
  const { source, bucketSeconds } = chooseBucket(query.toMs - query.fromMs, query.maxPoints);
  const ids = [...query.pointIds];
  const from = new Date(query.fromMs).toISOString();
  const to = new Date(query.toMs).toISOString();
  const bin = sql`make_interval(secs => ${bucketSeconds})`;

  const { rows } =
    source === 'raw'
      ? await sql<BucketRow>`
          SELECT point_id,
            (extract(epoch FROM date_bin(${bin}, ts, ${BUCKET_ORIGIN_ISO}::timestamptz)) * 1000)::float8 AS t,
            min(value) AS v_min, avg(value) AS v_avg, max(value) AS v_max
          FROM om.measurement
          WHERE point_id = ANY(${ids}::int4[]) AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
          GROUP BY point_id, t
          ORDER BY point_id, t
        `.execute(db)
      : await sql<BucketRow>`
          SELECT point_id,
            (extract(epoch FROM date_bin(${bin}, bucket, ${BUCKET_ORIGIN_ISO}::timestamptz)) * 1000)::float8 AS t,
            min(v_min) AS v_min, avg(v_avg) AS v_avg, max(v_max) AS v_max
          FROM om.m_1h
          WHERE point_id = ANY(${ids}::int4[])
            AND bucket > ${from}::timestamptz - interval '1 hour' AND bucket < ${to}::timestamptz
          GROUP BY point_id, t
          ORDER BY point_id, t
        `.execute(db);

  const byPoint = new Map<number, SeriesRow[]>(ids.map((id) => [id, []]));
  for (const row of rows) {
    byPoint.get(row.point_id)?.push([row.t, row.v_min, row.v_avg, row.v_max]);
  }

  return {
    source,
    bucketSeconds,
    fromMs: query.fromMs,
    toMs: query.toMs,
    series: ids.map((pointId) => ({ pointId, rows: byPoint.get(pointId) ?? [] })),
  };
}
