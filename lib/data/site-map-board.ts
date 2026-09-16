import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import type { HourBucket } from './energy-calc';
import {
  ABSENT,
  EMPTY_MAP_METRICS,
  MAP_METRICS,
  MAP_METRIC_KEYS,
  hourlyCurve,
  mapKpiTiles,
  type CurvePoint,
  type MapKpiTile,
  type MapMetricKey,
  type MapMetrics,
} from './map-kpi';
import { getSiteMapStatus, type SiteMapStatus } from './site-map';
import { HOUR_MS, kstDayStartMs, type TimeWindow } from './time';

export interface FleetMapSite extends SiteMapStatus {
  /** 상세 패널의 수치 타일 4개 (오늘 KST 00:00 ~ 지금) */
  readonly tiles: readonly MapKpiTile[];
  /** 오늘 시간대별 발전 곡선 */
  readonly curve: readonly CurvePoint[];
  readonly curveLabel: string;
  readonly curveUnit: string;
}

interface MetricPoint {
  readonly pointId: number;
  readonly siteId: number;
  readonly key: MapMetricKey;
}

interface MetricRows {
  readonly points: readonly MetricPoint[];
  readonly buckets: ReadonlyMap<number, HourBucket[]>;
}

const keyOf = (classKey: string | null, metricKey: string): MapMetricKey | undefined =>
  MAP_METRIC_KEYS.find((key) => MAP_METRICS[key].classKey === classKey && MAP_METRICS[key].metricKey === metricKey);

/**
 * 지도 타일·곡선이 쓰는 포인트와 오늘 버킷을 한 번에 읽는다 (lib/data/energy.ts와 같은 방식).
 * LEFT JOIN이라 수신이 없는 포인트도 남는다: '해당 없음'과 '데이터 없음'을 가르는 데 쓴다.
 * 카운터 기준값을 위해 오늘 00:00의 한 시간 전 버킷부터 읽는다.
 */
async function loadMetricRows(window: TimeWindow): Promise<MetricRows> {
  const rows = await db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .leftJoin('om.m_1h as b', (join) =>
      join
        .onRef('b.point_id', '=', 'p.id')
        .on('b.bucket', '>=', new Date(window.fromMs - HOUR_MS))
        .on('b.bucket', '<', new Date(window.toMs)),
    )
    .select([
      'p.id',
      'a.site_id',
      'a.class_key',
      'p.metric_key',
      sql<number | null>`(extract(epoch FROM b.bucket) * 1000)::float8`.as('bucket_ms'),
      'b.v_first',
      'b.v_last',
      'b.v_avg',
    ])
    .where((eb) =>
      eb.or(
        MAP_METRIC_KEYS.map((key) =>
          eb.and([eb('a.class_key', '=', MAP_METRICS[key].classKey), eb('p.metric_key', '=', MAP_METRICS[key].metricKey)]),
        ),
      ),
    )
    .execute();

  const points = new Map<number, MetricPoint>();
  const buckets = new Map<number, HourBucket[]>();
  for (const row of rows) {
    const key = keyOf(row.class_key, row.metric_key);
    if (key === undefined) continue;
    points.set(row.id, { pointId: row.id, siteId: row.site_id, key });
    if (row.bucket_ms === null) continue;
    buckets.set(row.id, [...(buckets.get(row.id) ?? []), { bucketMs: row.bucket_ms, first: row.v_first, last: row.v_last, avg: row.v_avg }]);
  }
  return { points: [...points.values()], buckets };
}

/** 사이트별 태양광 인버터 직류 정격용량 합 [kWp] (성능지수의 분모) */
async function loadDcKwp(): Promise<ReadonlyMap<number, number>> {
  const { rows } = await sql<{ site_id: number; dc_kwp: number | null }>`
    SELECT site_id, sum((nameplate ->> 'dc_kwp')::float8) AS dc_kwp
    FROM om.asset WHERE class_key = ${MAP_METRICS.pvKwh.classKey}
    GROUP BY site_id
  `.execute(db);
  return new Map(rows.flatMap((row) => (row.dc_kwp === null ? [] : [[row.site_id, row.dc_kwp] as const])));
}

function metricsOf(rows: MetricRows, siteId: number, window: TimeWindow): MapMetrics {
  const entries = MAP_METRIC_KEYS.map((key): [MapMetricKey, MapMetrics[MapMetricKey]] => {
    const points = rows.points.filter((point) => point.siteId === siteId && point.key === key);
    if (points.length === 0) return [key, ABSENT];
    const curve = hourlyCurve(MAP_METRICS[key].method, points.map((point) => rows.buckets.get(point.pointId) ?? []), window);
    const values = curve.map((entry) => entry.value).filter((value): value is number => value !== null);
    return [key, { present: true, value: values.length === 0 ? null : values.reduce((total, value) => total + value, 0) }];
  });
  return Object.fromEntries(entries) as MapMetrics;
}

/** 곡선은 태양광 발전량, 태양광이 없으면 연료전지 발전량을 그린다 */
function curveOf(rows: MetricRows, siteId: number, window: TimeWindow): Pick<FleetMapSite, 'curve' | 'curveLabel' | 'curveUnit'> {
  const key: MapMetricKey = rows.points.some((point) => point.siteId === siteId && point.key === 'pvKwh') ? 'pvKwh' : 'fcKwh';
  const points = rows.points.filter((point) => point.siteId === siteId && point.key === key);
  return {
    curve: hourlyCurve(MAP_METRICS[key].method, points.map((point) => rows.buckets.get(point.pointId) ?? []), window),
    curveLabel: key === 'pvKwh' ? '시간대별 태양광 발전량' : '시간대별 연료전지 발전량',
    curveUnit: 'kWh',
  };
}

/**
 * 플릿 지도 화면 한 벌: 사이트 상태(마커 색·목록 정렬) + 상세 패널의 타일·곡선.
 * 세 질의를 동시에 보내고 사이트 수만큼 왕복하지 않는다.
 */
export async function getFleetMapSites(nowMs: number): Promise<Readonly<{ sites: readonly FleetMapSite[]; today: TimeWindow }>> {
  const today: TimeWindow = { fromMs: kstDayStartMs(nowMs), toMs: nowMs };
  const [statuses, rows, dcKwp] = await Promise.all([getSiteMapStatus(nowMs), loadMetricRows(today), loadDcKwp()]);
  const sites = statuses.map((status): FleetMapSite => {
    const metrics = rows.points.some((point) => point.siteId === status.siteId) ? metricsOf(rows, status.siteId, today) : EMPTY_MAP_METRICS;
    return { ...status, tiles: mapKpiTiles(metrics, dcKwp.get(status.siteId) ?? null), ...curveOf(rows, status.siteId, today) };
  });
  return { sites, today };
}
