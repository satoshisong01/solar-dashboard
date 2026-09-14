import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import {
  ENERGY_KPIS,
  ENERGY_KPI_KEYS,
  computeEnergy,
  sumNullable,
  type EnergyKpiKey,
  type HourBucket,
} from './energy-calc';
import { HOUR_MS, type TimeWindow } from './time';

/** present: 사이트에 이 KPI의 원천 포인트가 있는가 (없으면 화면에서 '해당 없음'·숨김) / value: 구간 값, 데이터가 없으면 null */
export interface KpiValue {
  readonly present: boolean;
  readonly value: number | null;
}

export type EnergyValues = Readonly<Record<EnergyKpiKey, KpiValue>>;

interface KpiPoint {
  readonly pointId: number;
  readonly siteId: number;
  readonly kpi: EnergyKpiKey;
}

async function findKpiPoints(siteIds: readonly number[] | undefined): Promise<readonly KpiPoint[]> {
  let query = db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .select(['p.id', 'a.site_id', 'a.class_key', 'p.metric_key'])
    .where((eb) =>
      eb.or(
        ENERGY_KPI_KEYS.map((key) =>
          eb.and([eb('a.class_key', '=', ENERGY_KPIS[key].classKey), eb('p.metric_key', '=', ENERGY_KPIS[key].metricKey)]),
        ),
      ),
    );
  if (siteIds !== undefined) {
    if (siteIds.length === 0) return [];
    query = query.where('a.site_id', 'in', [...siteIds]);
  }
  const rows = await query.execute();
  return rows.flatMap((row) => {
    const kpi = ENERGY_KPI_KEYS.find(
      (key) => ENERGY_KPIS[key].classKey === row.class_key && ENERGY_KPIS[key].metricKey === row.metric_key,
    );
    return kpi ? [{ pointId: row.id, siteId: row.site_id, kpi }] : [];
  });
}

async function loadBuckets(pointIds: readonly number[], fromMs: number, toMs: number): Promise<ReadonlyMap<number, HourBucket[]>> {
  const byPoint = new Map<number, HourBucket[]>();
  if (pointIds.length === 0) return byPoint;
  const { rows } = await sql<{ point_id: number; bucket_ms: number; v_first: number | null; v_last: number | null; v_avg: number | null }>`
    SELECT point_id, (extract(epoch FROM bucket) * 1000)::float8 AS bucket_ms, v_first, v_last, v_avg
    FROM om.m_1h
    WHERE point_id = ANY(${[...pointIds]}::int4[])
      AND bucket >= ${new Date(fromMs).toISOString()}::timestamptz AND bucket < ${new Date(toMs).toISOString()}::timestamptz
  `.execute(db);
  for (const row of rows) {
    const bucket: HourBucket = { bucketMs: row.bucket_ms, first: row.v_first, last: row.v_last, avg: row.v_avg };
    byPoint.set(row.point_id, [...(byPoint.get(row.point_id) ?? []), bucket]);
  }
  return byPoint;
}

/**
 * 사이트별·구간별 발전·수소 요약 (m_1h 기반). 결과 배열은 windows 순서와 같다.
 * 카운터 기준값을 위해 가장 이른 구간의 1시간 전 버킷부터 읽는다.
 */
export async function getEnergyByWindows(
  windows: readonly TimeWindow[],
  siteIds?: readonly number[],
): Promise<ReadonlyMap<number, readonly EnergyValues[]>> {
  const points = await findKpiPoints(siteIds);
  if (windows.length === 0) return new Map();
  const fromMs = Math.min(...windows.map((w) => w.fromMs)) - HOUR_MS;
  const toMs = Math.max(...windows.map((w) => w.toMs));
  const buckets = await loadBuckets(points.map((p) => p.pointId), fromMs, toMs);

  const siteIdsInResult = siteIds ?? [...new Set(points.map((p) => p.siteId))];
  return new Map(
    siteIdsInResult.map((siteId) => {
      const sitePoints = points.filter((p) => p.siteId === siteId);
      const perWindow = windows.map((window) => {
        const entries = ENERGY_KPI_KEYS.map((key): [EnergyKpiKey, KpiValue] => {
          const kpiPoints = sitePoints.filter((p) => p.kpi === key);
          const values = kpiPoints.map((p) => computeEnergy(ENERGY_KPIS[key].method, buckets.get(p.pointId) ?? [], window));
          return [key, { present: kpiPoints.length > 0, value: sumNullable(values) }];
        });
        return Object.fromEntries(entries) as EnergyValues;
      });
      return [siteId, perWindow] as const;
    }),
  );
}

export interface SiteTodayKpis {
  readonly energy: EnergyValues;
  /** ESS 랙 SOC 시간 평균들의 평균 (%) */
  readonly essSocAvg: KpiValue;
  /** 전해조 수소 유량이 0보다 큰 샘플 비율 (0~1, 수신 샘플 기준) */
  readonly elzRunningRatio: KpiValue;
}

const EMPTY_ENERGY = Object.fromEntries(ENERGY_KPI_KEYS.map((key) => [key, { present: false, value: null }])) as EnergyValues;

/** 사이트 상세 KPI (오늘 KST 00:00 ~ now) */
export async function getSiteTodayKpis(siteId: number, today: TimeWindow): Promise<SiteTodayKpis> {
  const from = new Date(today.fromMs).toISOString();
  const to = new Date(today.toMs).toISOString();
  const [energyBySite, soc, elz] = await Promise.all([
    getEnergyByWindows([today], [siteId]),
    sql<{ points: number; avg: number | null }>`
      SELECT (SELECT count(*) FROM om.point p JOIN om.asset a ON a.id = p.asset_id
              WHERE a.site_id = ${siteId} AND a.class_key = 'ess.rack' AND p.metric_key = 'batt.soc')::int AS points,
        (SELECT avg(m.v_avg) FROM om.m_1h m
          JOIN om.point p ON p.id = m.point_id JOIN om.asset a ON a.id = p.asset_id
          WHERE a.site_id = ${siteId} AND a.class_key = 'ess.rack' AND p.metric_key = 'batt.soc'
            AND m.bucket >= ${from}::timestamptz AND m.bucket < ${to}::timestamptz) AS avg
    `.execute(db),
    sql<{ points: number; samples: number; running: number }>`
      SELECT (SELECT count(*) FROM om.point p JOIN om.asset a ON a.id = p.asset_id
              WHERE a.site_id = ${siteId} AND a.class_key = 'h2.elz' AND p.metric_key = 'h2.flow.mass')::int AS points,
        count(m.value)::int AS samples,
        (count(*) FILTER (WHERE m.value > 0))::int AS running
      FROM om.measurement m
      JOIN om.point p ON p.id = m.point_id JOIN om.asset a ON a.id = p.asset_id
      WHERE a.site_id = ${siteId} AND a.class_key = 'h2.elz' AND p.metric_key = 'h2.flow.mass'
        AND m.ts >= ${from}::timestamptz AND m.ts < ${to}::timestamptz
    `.execute(db),
  ]);

  const socRow = soc.rows[0];
  const elzRow = elz.rows[0];
  return {
    energy: energyBySite.get(siteId)?.[0] ?? EMPTY_ENERGY,
    essSocAvg: { present: (socRow?.points ?? 0) > 0, value: socRow?.avg ?? null },
    elzRunningRatio: {
      present: (elzRow?.points ?? 0) > 0,
      value: elzRow && elzRow.samples > 0 ? elzRow.running / elzRow.samples : null,
    },
  };
}
