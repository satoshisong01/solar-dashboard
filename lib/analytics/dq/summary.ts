// dq.gap_flatline 입력 요약 (순수): 포인트별 시간 샘플 수 → 결측 구간, 원시 같은 값 연속 → 고착 구간.
// DB 실행기(lib/analysis/dq-summary.ts)는 시간 수를 1시간 롤업에서, 고착 구간을 SQL에서 구하고,
// 시뮬레이터 평가(lib/sim/eval)는 메모리 시계열에서 같은 규칙으로 구한다 (규칙은 두 곳이 같아야 한다).
// 고착 규칙
//   - metric_def.flatline_max_s가 있는 메트릭만, 값이 NULL이 아닌 샘플을 시각 순으로 보고 같은 값이 이어진 구간
//   - 구간 = 처음 샘플 시각 ~ 마지막 샘플 시각 + 공칭 주기(마지막 샘플이 덮는 시간까지). 길이가 flatline_max_s 이상이면 고착
//     (6시간 고착이 샘플 간격만큼 짧게 재져 6시간 기준에서 빠지지 않게: 결측 구간도 시간 버킷 전체를 덮는 것과 같은 방식)
//   - 일사량(POA·GHI)은 야간 0 근처 값이 늘 같으므로 |값| ≤ 야간 상한인 구간은 고착으로 보지 않는다 (주간만 판단)
import type { DqGapFlatlineInput, DqPointSummary } from '../detectors/dq-gap-flatline';
import { MS_PER_HOUR, type TimeWindow } from '../types';

export interface DqPointMeta {
  readonly pointId: number;
  readonly assetId: number;
  /** 메트릭 키 (한정자가 있으면 'key#qualifier') */
  readonly metricKey: string;
  readonly sourceKey: string;
  readonly periodS: number | null;
  readonly flatlineMaxS: number | null;
}

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

/** 야간 값이 0 근처로 고정되는 메트릭: 이 절댓값 이하 구간은 고착 판정에서 뺀다 [정규 단위] */
export const FLATLINE_NIGHT_MAX_ABS: Readonly<Record<string, number>> = { 'poa.irradiance': 5, 'ghi.irradiance': 5 };

/** 고착 판정에서 뺄 절댓값 상한 (없으면 null) */
export function flatlineIgnoreAbsBelow(metricKey: string): number | null {
  return FLATLINE_NIGHT_MAX_ABS[metricKey.split('#')[0] ?? metricKey] ?? null;
}

/** 순수: 포인트·시간 개수·고착 구간 → 탐지기 입력 요약 */
export function summarizePoints(points: readonly DqPointMeta[], hours: readonly HourCount[], flatRuns: readonly FlatRun[], window: TimeWindow): DqPointSummary[] {
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

/** 원시 샘플(시각 오름차순, NaN = 받지 못한 샘플) → [window) 안 고착 구간. SQL(lib/analysis/dq-summary.ts)과 같은 규칙 */
export function flatRunsFromSamples(point: DqPointMeta, ts: ArrayLike<number>, values: ArrayLike<number>, window: TimeWindow): FlatRun[] {
  if (point.flatlineMaxS === null) return [];
  const minMs = point.flatlineMaxS * 1000;
  const periodMs = (point.periodS ?? 0) * 1000;
  const ignoreBelow = flatlineIgnoreAbsBelow(point.metricKey);
  const runs: FlatRun[] = [];
  let run: { start: number; last: number; value: number } | null = null;
  const close = () => {
    if (run && run.last + periodMs - run.start >= minMs && !(ignoreBelow !== null && Math.abs(run.value) <= ignoreBelow)) runs.push({ pointId: point.pointId, start: run.start, end: run.last + periodMs, value: run.value });
  };
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as number;
    const v = values[i] as number;
    if (t < window.start || t >= window.end || !Number.isFinite(v)) continue;
    if (run && v === run.value) {
      run.last = t;
      continue;
    }
    close();
    run = { start: t, last: t, value: v };
  }
  close();
  return runs;
}

/** 원시 샘플 → [window) 안 시간별 받은 샘플 수 (NaN = 받지 못한 샘플). 샘플이 없는 시간은 넣지 않는다 */
export function hourCountsFromSamples(pointId: number, ts: ArrayLike<number>, values: ArrayLike<number>, window: TimeWindow): HourCount[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as number;
    if (t < window.start || t >= window.end || !Number.isFinite(values[i] as number)) continue;
    const hour = Math.floor(t / MS_PER_HOUR) * MS_PER_HOUR;
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([hourStart, n]) => ({ pointId, hourStart, n }));
}

export interface MemoryDqPoint {
  readonly meta: DqPointMeta;
  readonly ts: ArrayLike<number>;
  readonly values: ArrayLike<number>;
}

/** 메모리 시계열 → dq.gap_flatline 입력 (DB 경로의 loadDqInput과 같은 요약. 데이터 구간 축소는 하지 않는다) */
export function memoryDqInput(siteId: number, points: readonly MemoryDqPoint[], window: TimeWindow): DqGapFlatlineInput {
  const hours = points.flatMap((p) => hourCountsFromSamples(p.meta.pointId, p.ts, p.values, window));
  const flatRuns = points.flatMap((p) => flatRunsFromSamples(p.meta, p.ts, p.values, window));
  return { siteId, window, points: summarizePoints(points.map((p) => p.meta), hours, flatRuns, window) };
}
