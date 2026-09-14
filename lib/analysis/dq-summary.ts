// dq.gap_flatline 입력: 포인트별 결측(1시간 롤업 공백)·고착(원시 같은 값 연속) 구간을 SQL로 요약한다.
// - 창은 사이트에 실제 데이터가 있는 구간으로 줄인다 (수집 시작 전·마지막 수신 이후를 결측으로 세지 않음)
// - 결측: 시간 버킷이 없거나 n = 0인 시간의 연속 구간. 받은 샘플 = Σ n
// - 고착: metric_def.flatline_max_s가 있는 메트릭만, 같은 값이 그 시간 넘게 이어진 원시 구간
import { sql, type Kysely } from 'kysely';
import type { DqGapFlatlineInput, DqPointSummary } from '@/lib/analytics/detectors/dq-gap-flatline';
import { MS_PER_HOUR, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import type { PointRow } from './catalog';

const iso = (ms: number): string => new Date(ms).toISOString();

export interface HourCount {
  readonly pointId: number;
  readonly hourStart: number;
  readonly n: number;
}

export interface FlatRun {
  readonly pointId: number;
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

/** 순수: 포인트·시간 개수·고착 구간 → 탐지기 입력 요약 */
export function summarizePoints(points: readonly PointRow[], hours: readonly HourCount[], flatRuns: readonly FlatRun[], window: TimeWindow): DqPointSummary[] {
  const firstHour = Math.ceil(window.start / MS_PER_HOUR) * MS_PER_HOUR;
  const hourCount = Math.max(0, Math.floor((window.end - firstHour) / MS_PER_HOUR));
  const countsByPoint = new Map<number, Map<number, number>>();
  for (const h of hours) countsByPoint.set(h.pointId, (countsByPoint.get(h.pointId) ?? new Map<number, number>()).set(h.hourStart, h.n));
  return points
    .filter((p) => p.periodS !== null && p.periodS > 0)
    .map((point) => {
      const counts = countsByPoint.get(point.pointId) ?? new Map<number, number>();
      const gaps: TimeWindow[] = [];
      let received = 0;
      for (let i = 0; i < hourCount; i += 1) {
        const hour = firstHour + i * MS_PER_HOUR;
        const n = counts.get(hour) ?? 0;
        received += n;
        if (n > 0) continue;
        const last = gaps.at(-1);
        if (last && last.end === hour) gaps[gaps.length - 1] = { start: last.start, end: hour + MS_PER_HOUR };
        else gaps.push({ start: hour, end: hour + MS_PER_HOUR });
      }
      return {
        pointId: point.pointId,
        assetId: point.assetId,
        metricKey: point.metricKey,
        sourceKey: point.sourceKey,
        expectedSamples: Math.round((hourCount * 3600) / (point.periodS ?? 1)),
        receivedSamples: received,
        gaps,
        flatlines: flatRuns.filter((f) => f.pointId === point.pointId).map(({ start, end, value }) => ({ start, end, value })),
      };
    });
}

/** 사이트 포인트들의 데이터 구간으로 줄인 창. 데이터가 없으면 null */
async function dataWindow(db: Kysely<DB>, pointIds: readonly number[], window: TimeWindow): Promise<TimeWindow | null> {
  const { rows } = await sql<{ first_ms: number | null; last_ms: number | null }>`
    SELECT (extract(epoch FROM min(bucket)) * 1000)::float8 AS first_ms, (extract(epoch FROM max(bucket)) * 1000)::float8 AS last_ms
    FROM om.m_1h
    WHERE point_id = ANY(${[...pointIds]}::int4[]) AND bucket >= ${iso(window.start)}::timestamptz AND bucket < ${iso(window.end)}::timestamptz AND n > 0
  `.execute(db);
  const row = rows[0];
  if (!row || row.first_ms === null || row.last_ms === null) return null;
  return { start: Math.max(window.start, row.first_ms), end: Math.min(window.end, row.last_ms + MS_PER_HOUR) };
}

async function flatRunsOf(db: Kysely<DB>, points: readonly PointRow[], window: TimeWindow): Promise<FlatRun[]> {
  const flat = points.filter((p) => p.flatlineMaxS !== null);
  if (flat.length === 0) return [];
  const { rows } = await sql<{ point_id: number; start_ms: number; end_ms: number; value: number }>`
    WITH limits AS (SELECT * FROM unnest(${flat.map((p) => p.pointId)}::int4[], ${flat.map((p) => p.flatlineMaxS ?? 0)}::int4[]) AS l(point_id, max_s)),
    marked AS (
      SELECT m.point_id, m.ts, m.value,
        CASE WHEN m.value IS NOT DISTINCT FROM lag(m.value) OVER w THEN 0 ELSE 1 END AS changed
      FROM om.measurement m JOIN limits l ON l.point_id = m.point_id
      WHERE m.ts >= ${iso(window.start)}::timestamptz AND m.ts < ${iso(window.end)}::timestamptz AND m.value IS NOT NULL
      WINDOW w AS (PARTITION BY m.point_id ORDER BY m.ts)
    ),
    runs AS (SELECT point_id, ts, value, sum(changed) OVER (PARTITION BY point_id ORDER BY ts) AS run FROM marked)
    SELECT r.point_id, (extract(epoch FROM min(r.ts)) * 1000)::float8 AS start_ms, (extract(epoch FROM max(r.ts)) * 1000)::float8 AS end_ms, min(r.value) AS value
    FROM runs r JOIN limits l ON l.point_id = r.point_id
    GROUP BY r.point_id, r.run, l.max_s
    HAVING max(r.ts) - min(r.ts) > make_interval(secs => l.max_s)
    ORDER BY r.point_id, min(r.ts)
  `.execute(db);
  return rows.map((row) => ({ pointId: row.point_id, start: row.start_ms, end: row.end_ms, value: row.value }));
}

/** 사이트(또는 설비 일부) 데이터 품질 요약. 데이터가 없으면 null */
export async function loadDqInput(db: Kysely<DB>, siteId: number, points: readonly PointRow[], window: TimeWindow): Promise<DqGapFlatlineInput | null> {
  if (points.length === 0) return null;
  const clamped = await dataWindow(db, points.map((p) => p.pointId), window);
  if (!clamped || clamped.end <= clamped.start) return null;
  const [hours, flatRuns] = await Promise.all([
    sql<{ point_id: number; hour_ms: number; n: number }>`
      SELECT point_id, (extract(epoch FROM bucket) * 1000)::float8 AS hour_ms, n
      FROM om.m_1h
      WHERE point_id = ANY(${points.map((p) => p.pointId)}::int4[]) AND bucket >= ${iso(clamped.start)}::timestamptz AND bucket < ${iso(clamped.end)}::timestamptz
    `.execute(db),
    flatRunsOf(db, points, clamped),
  ]);
  const counts = hours.rows.map((row) => ({ pointId: row.point_id, hourStart: row.hour_ms, n: row.n }));
  return { siteId, window: clamped, points: summarizePoints(points, counts, flatRuns, clamped) };
}
