// 원시 측정값·1시간 롤업 조회. 원시는 대용량이라 기간을 청크로 나눠 읽고, 시각은 DB에서 epoch ms로 바꿔 받는다.
import { sql, type Kysely } from 'kysely';
import { chargeCurve, type ChargeCurvePoint } from '@/lib/analytics/episodes/ess-features';
import type { StackPriorState } from '@/lib/analytics/episodes/stack';
import { BAD_MASK } from '@/lib/ingest/quality';
import type { HourlyPointRow } from '@/lib/analytics/pipeline/kpis';
import type { SeriesRequest } from '@/lib/analytics/pipeline/sources';
import type { AssetSeries, Sample, TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import type { PointRow } from './catalog';

/** 원시 조회 청크 길이 (1분 주기 포인트 7개 × 7일 ≈ 7만 행) */
export const SERIES_CHUNK_MS = 7 * 86_400_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** 요청 (설비, 메트릭) → 포인트 id. 한정자 없는 포인트만 */
export function pointIdsFor(requests: readonly SeriesRequest[], points: readonly PointRow[]): Map<number, string> {
  return new Map(
    requests.flatMap((request) => {
      const point = points.find((p) => p.assetId === request.assetId && p.metricKey === request.metricKey);
      return point ? [[point.pointId, request.metricKey] as const] : [];
    }),
  );
}

interface SampleRow {
  readonly point_id: number;
  readonly ts: number;
  readonly value: number | null;
  readonly quality: number;
}

/** [window.start, window.end) 원시 → 메트릭 키별 샘플 (ts 오름차순) */
export async function loadAssetSeries(db: Kysely<DB>, requests: readonly SeriesRequest[], points: readonly PointRow[], window: TimeWindow): Promise<AssetSeries> {
  const byPoint = pointIdsFor(requests, points);
  const ids = [...byPoint.keys()];
  const series = new Map<string, Sample[]>([...byPoint.values()].map((metric) => [metric, []]));
  if (ids.length === 0) return {};
  for (let from = window.start; from < window.end; from += SERIES_CHUNK_MS) {
    const to = Math.min(window.end, from + SERIES_CHUNK_MS);
    const { rows } = await sql<SampleRow>`
      SELECT m.point_id, (extract(epoch FROM m.ts) * 1000)::float8 AS ts, m.value, m.quality
      FROM om.measurement m
      WHERE m.point_id = ANY(${ids}::int4[]) AND m.ts >= ${iso(from)}::timestamptz AND m.ts < ${iso(to)}::timestamptz
      ORDER BY m.point_id, m.ts
    `.execute(db);
    for (const row of rows) series.get(byPoint.get(row.point_id) ?? '')?.push({ ts: row.ts, value: row.value, quality: row.quality }); // 이 함수 안에서 만든 배열만 채운다
  }
  return Object.fromEntries(series);
}

interface HourlySqlRow {
  readonly point_id: number;
  readonly hour_start: number;
  readonly n: number;
  readonly n_good: number;
  readonly v_avg: number | null;
  readonly v_first: number | null;
  readonly v_last: number | null;
}

/** 포인트들의 1시간 롤업 행 */
export async function loadHourly(db: Kysely<DB>, points: readonly PointRow[], window: TimeWindow): Promise<HourlyPointRow[]> {
  if (points.length === 0) return [];
  const byId = new Map(points.map((p) => [p.pointId, p]));
  const { rows } = await sql<HourlySqlRow>`
    SELECT point_id, (extract(epoch FROM bucket) * 1000)::float8 AS hour_start, n, n_good, v_avg, v_first, v_last
    FROM om.m_1h
    WHERE point_id = ANY(${[...byId.keys()]}::int4[]) AND bucket >= ${iso(window.start)}::timestamptz AND bucket < ${iso(window.end)}::timestamptz
    ORDER BY point_id, bucket
  `.execute(db);
  return rows.flatMap((row) => {
    const point = byId.get(row.point_id);
    return point ? [{ assetId: point.assetId, metricKey: point.metricKey, periodS: point.periodS ?? 60, hourStart: row.hour_start, n: row.n, nGood: row.n_good, avg: row.v_avg, first: row.v_first, last: row.v_last }] : [];
  });
}

/** 충전 세션들의 에피소드 오버레이 곡선 (전류·SOC 원시를 세션마다 조회) */
export async function loadChargeCurves(db: Kysely<DB>, rackId: number, points: readonly PointRow[], sessions: readonly TimeWindow[]): Promise<{ start: number; points: ChargeCurvePoint[] }[]> {
  const requests = ['batt.current', 'batt.soc'].map((metricKey) => ({ assetId: rackId, metricKey }));
  const curves: { start: number; points: ChargeCurvePoint[] }[] = [];
  for (const session of sessions) {
    const series = await loadAssetSeries(db, requests, points, { start: session.start - 5 * 60_000, end: session.end + 60_000 });
    curves.push({ start: session.start, points: chargeCurve(series, session) });
  }
  return curves;
}

/**
 * 스택 추출 창 시작 전 운전 상태: 창 앞 마지막 good 전류 샘플이 비운전인지와 마지막 운전 샘플 시각.
 * 파티션마다 (point_id, ts) 기본키 인덱스를 역순으로 읽어 첫 행만 쓴다.
 */
export async function loadStackPriorState(db: Kysely<DB>, currentPointId: number, before: number, runningA: number): Promise<StackPriorState> {
  const { rows } = await sql<{ last_value: number | null; running_ms: number | null }>`
    SELECT
      (SELECT m.value FROM om.measurement m
        WHERE m.point_id = ${currentPointId} AND m.ts < ${iso(before)}::timestamptz AND m.value IS NOT NULL AND (m.quality & ${BAD_MASK}::int2) = 0
        ORDER BY m.ts DESC LIMIT 1) AS last_value,
      (SELECT (extract(epoch FROM m.ts) * 1000)::float8 FROM om.measurement m
        WHERE m.point_id = ${currentPointId} AND m.ts < ${iso(before)}::timestamptz AND m.value >= ${runningA}::float8 AND (m.quality & ${BAD_MASK}::int2) = 0
        ORDER BY m.ts DESC LIMIT 1) AS running_ms
  `.execute(db);
  const row = rows[0];
  return { lastRunningTs: row?.running_ms ?? null, offBeforeWindow: row?.last_value !== null && row?.last_value !== undefined && row.last_value < runningA };
}
