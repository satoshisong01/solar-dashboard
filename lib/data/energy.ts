import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import {
  ENERGY_KPIS,
  ENERGY_KPI_KEYS,
  computeEnergy,
  ratedPerHour,
  sumEnergyResults,
  type EnergyKpiKey,
  type HourBucket,
} from './energy-calc';
import { HOUR_MS, type TimeWindow } from './time';

/** present: 사이트에 이 KPI의 원천 포인트가 있는가 (없으면 화면에서 '해당 없음'·숨김) / value: 구간 값, 데이터가 없으면 null */
export interface KpiValue {
  readonly present: boolean;
  readonly value: number | null;
}

/** 발전·수소 KPI 값. 값에 넣지 않은 것(정격 밖 카운터 점프·대기 소비)을 함께 알린다 */
export interface EnergyKpiValue extends KpiValue {
  /** 설비 정격으로 설명되지 않는 카운터 점프를 빼고 더했다 — 화면은 '데이터 의심'으로 알린다 */
  readonly suspect: boolean;
  /** 값에 넣지 않은 정지 중 대기 소비 [kWh] */
  readonly standby: number;
}

export type EnergyValues = Readonly<Record<EnergyKpiKey, EnergyKpiValue>>;

interface KpiPoint {
  readonly pointId: number;
  readonly siteId: number;
  readonly kpi: EnergyKpiKey;
  /** 설비 명판에서 읽은 시간당 최대 증가량 (카운터 점프 상한). 명판에 없으면 null */
  readonly maxPerHour: number | null;
}

interface KpiPointsAndBuckets {
  readonly points: readonly KpiPoint[];
  readonly buckets: ReadonlyMap<number, HourBucket[]>;
}

/**
 * KPI 포인트와 그 포인트의 구간 버킷을 한 번에 읽는다.
 * 포인트 id를 먼저 받아 버킷 쿼리에 넘기면 왕복이 두 번이라 한 쿼리로 합쳤다.
 * 버킷은 LEFT JOIN이라 수신이 없는 포인트도 남는다 (KPI '해당 없음'과 '데이터 없음'을 가르는 데 쓴다).
 */
async function loadKpiPointsAndBuckets(
  siteIds: readonly number[] | undefined,
  fromMs: number,
  toMs: number,
): Promise<KpiPointsAndBuckets> {
  const empty = { points: [], buckets: new Map<number, HourBucket[]>() };
  if (siteIds !== undefined && siteIds.length === 0) return empty;

  let query = db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .leftJoin('om.m_1h as b', (join) =>
      join
        .onRef('b.point_id', '=', 'p.id')
        .on('b.bucket', '>=', new Date(fromMs))
        .on('b.bucket', '<', new Date(toMs)),
    )
    .select([
      'p.id',
      'a.site_id',
      'a.class_key',
      'a.nameplate',
      'p.metric_key',
      sql<number | null>`(extract(epoch FROM b.bucket) * 1000)::float8`.as('bucket_ms'),
      'b.v_first',
      'b.v_last',
      'b.v_avg',
    ])
    .where((eb) =>
      eb.or(
        ENERGY_KPI_KEYS.map((key) =>
          eb.and([eb('a.class_key', '=', ENERGY_KPIS[key].classKey), eb('p.metric_key', '=', ENERGY_KPIS[key].metricKey)]),
        ),
      ),
    );
  if (siteIds !== undefined) query = query.where('a.site_id', 'in', [...siteIds]);

  const rows = await query.execute();
  const points = new Map<number, KpiPoint>();
  const buckets = new Map<number, HourBucket[]>();
  for (const row of rows) {
    const kpi = ENERGY_KPI_KEYS.find(
      (key) => ENERGY_KPIS[key].classKey === row.class_key && ENERGY_KPIS[key].metricKey === row.metric_key,
    );
    if (kpi === undefined) continue;
    points.set(row.id, { pointId: row.id, siteId: row.site_id, kpi, maxPerHour: ratedPerHour(row.nameplate, kpi) });
    if (row.bucket_ms === null) continue;
    const bucket: HourBucket = { bucketMs: row.bucket_ms, first: row.v_first, last: row.v_last, avg: row.v_avg };
    buckets.set(row.id, [...(buckets.get(row.id) ?? []), bucket]);
  }
  return { points: [...points.values()], buckets };
}

/**
 * 사이트별·구간별 발전·수소 요약 (m_1h 기반). 결과 배열은 windows 순서와 같다.
 * 카운터 기준값을 위해 가장 이른 구간의 1시간 전 버킷부터 읽는다.
 */
export async function getEnergyByWindows(
  windows: readonly TimeWindow[],
  siteIds?: readonly number[],
): Promise<ReadonlyMap<number, readonly EnergyValues[]>> {
  if (windows.length === 0) return new Map();
  const fromMs = Math.min(...windows.map((w) => w.fromMs)) - HOUR_MS;
  const toMs = Math.max(...windows.map((w) => w.toMs));
  const { points, buckets } = await loadKpiPointsAndBuckets(siteIds, fromMs, toMs);

  const siteIdsInResult = siteIds ?? [...new Set(points.map((p) => p.siteId))];
  return new Map(
    siteIdsInResult.map((siteId) => {
      const sitePoints = points.filter((p) => p.siteId === siteId);
      const perWindow = windows.map((window) => {
        const entries = ENERGY_KPI_KEYS.map((key): [EnergyKpiKey, EnergyKpiValue] => {
          const kpiPoints = sitePoints.filter((p) => p.kpi === key);
          const result = sumEnergyResults(kpiPoints.map((p) => computeEnergy(ENERGY_KPIS[key].method, buckets.get(p.pointId) ?? [], window, p.maxPerHour)));
          return [key, { present: kpiPoints.length > 0, ...result }];
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

const EMPTY_ENERGY = Object.fromEntries(ENERGY_KPI_KEYS.map((key) => [key, { present: false, value: null, suspect: false, standby: 0 }])) as EnergyValues;

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
