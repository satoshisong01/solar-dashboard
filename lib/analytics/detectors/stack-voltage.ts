// 스택 셀 전압 운전시간 추세 엔진 (el.voltage_rise · fc.voltage_decay 공용, 설계 §4.1 운전시간 축 열화 추적).
// 1) break-in 이후·유효 정상운전 구간을 전류밀도×온도 bin으로 나누고 bin별 중앙값을 빼서 조건 차이를 없앤다.
// 2) bin 안에 남은 전류밀도·온도 차이를 Theil–Sen 기울기로 한 번 더 보정한다.
// 3) 보정한 전압 잔차 vs 누적 운전시간 Theil–Sen(µV/h) + CI, Mann–Kendall, CUSUM.
import { downsample } from '../episodes/series';
import { median, quantile } from '../stats/robust';
import { theilSen, trendValueAt } from '../stats/trend';
import type { JsonObject } from '../types';
import { groupedMedians, r, summarizeTrend, type TrendSummary } from './common';

export interface StackPoint {
  readonly start: number;
  readonly opHours: number;
  readonly jMean: number;
  readonly jBin: number;
  readonly tMean: number | null;
  readonly tBin: number | null;
  /** 셀 전압 [V] */
  readonly voltage: number;
  readonly completeness: number;
}

export interface StackTrendParams {
  readonly breakInHours: number;
  readonly minPerBin: number;
  readonly minTotal: number;
  readonly minSpanHours: number;
  readonly minCompleteness: number;
  readonly maxPoints: number;
  readonly cusumK: number;
  readonly cusumH: number;
  readonly sigmaFloorMv: number;
}

export interface StackBinStat {
  readonly key: string;
  readonly n: number;
  readonly medianV: number;
  readonly opHoursMin: number;
  readonly opHoursMax: number;
}

export interface StackTrendResult {
  readonly points: readonly StackPoint[];
  readonly bins: readonly StackBinStat[];
  readonly excludedBreakIn: number;
  readonly slopeJ: number;
  readonly slopeT: number;
  /** 운전시간 축 추세 (y = 보정 전압 잔차 [V]) */
  readonly trend: TrendSummary;
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly referenceV: number;
}

export type StackTrendOutcome = { readonly ok: true; readonly result: StackTrendResult } | { readonly ok: false; readonly reason: string };

const binKey = (pt: StackPoint): string => `${pt.jBin}|${pt.tBin ?? 'na'}`;

/** 분산이 있는 성분만 Theil–Sen 기울기 (x가 서로 다른 값 3개 미만이면 0). 쌍 수를 줄이려고 일정 간격으로 표본을 뽑는다 */
function partialSlope(xs: readonly number[], ys: readonly number[], maxPoints: number): number {
  const pairs = downsample(xs.map((x, i) => [x, ys[i] as number] as const), maxPoints);
  if (new Set(pairs.map(([x]) => x)).size < 3) return 0;
  return theilSen(pairs.map(([x]) => x), pairs.map(([, y]) => y)).slope;
}

function groupByBin(points: readonly StackPoint[], minPerBin: number): Map<string, StackPoint[]> {
  const groups = new Map<string, StackPoint[]>();
  for (const pt of points) groups.set(binKey(pt), [...(groups.get(binKey(pt)) ?? []), pt]);
  return new Map([...groups.entries()].filter(([, members]) => members.length >= minPerBin));
}

/** 정상운전 점 → 운전시간 추세. 요건 미달이면 이유 */
export function stackVoltageTrend(input: readonly StackPoint[], p: StackTrendParams, direction: 'up' | 'down'): StackTrendOutcome {
  const usable = input.filter((pt) => pt.completeness >= p.minCompleteness && Number.isFinite(pt.voltage) && Number.isFinite(pt.opHours));
  const afterBreakIn = usable.filter((pt) => pt.opHours >= p.breakInHours);
  const groups = groupByBin(afterBreakIn, p.minPerBin);
  const points = [...groups.values()].flat().sort((a, b) => a.opHours - b.opHours);
  if (points.length < p.minTotal) return { ok: false, reason: `같은 조건 정상운전 구간 부족: ${points.length}개 (bin당 ${p.minPerBin}개, 합계 ${p.minTotal}개 필요, break-in ${p.breakInHours} h 이전 ${usable.length - afterBreakIn.length}개 제외)` };
  const span = (points[points.length - 1]?.opHours ?? 0) - (points[0]?.opHours ?? 0);
  if (span < p.minSpanHours) return { ok: false, reason: `누적 운전시간 범위 부족: ${span.toFixed(0)} h (${p.minSpanHours} h 필요)` };

  const centers = new Map([...groups.entries()].map(([key, members]) => [key, { v: median(members.map((m) => m.voltage)), j: median(members.map((m) => m.jMean)), t: median(members.map((m) => m.tMean ?? 0)) }]));
  const center = (pt: StackPoint) => centers.get(binKey(pt)) ?? { v: pt.voltage, j: pt.jMean, t: pt.tMean ?? 0 };
  const dv = points.map((pt) => pt.voltage - center(pt).v);
  const dj = points.map((pt) => pt.jMean - center(pt).j);
  const slopeJ = partialSlope(dj, dv, p.maxPoints);
  const afterJ = dv.map((v, i) => v - slopeJ * (dj[i] as number));
  const dt = points.map((pt) => (pt.tMean ?? center(pt).t) - center(pt).t);
  const slopeT = partialSlope(dt, afterJ, p.maxPoints);
  const residuals = afterJ.map((v, i) => v - slopeT * (dt[i] as number));

  const grouped = groupedMedians(points.map((pt) => pt.opHours), residuals, p.maxPoints);
  const trend = summarizeTrend(grouped.xs, grouped.ys, { referenceCount: Math.max(10, Math.ceil(grouped.xs.length / 4)), sigmaFloor: p.sigmaFloorMv / 1000, direction, k: p.cusumK, h: p.cusumH });
  if (!trend) return { ok: false, reason: '운전시간이 서로 다른 점이 3개 미만입니다' };
  const bins = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, members]) => ({ key, n: members.length, medianV: median(members.map((m) => m.voltage)), opHoursMin: Math.min(...members.map((m) => m.opHours)), opHoursMax: Math.max(...members.map((m) => m.opHours)) }));
  return { ok: true, result: { points, bins, excludedBreakIn: usable.length - afterBreakIn.length, slopeJ, slopeT, trend, xs: grouped.xs, ys: grouped.ys, referenceV: bins[0]?.medianV ?? 0 } };
}

/** 근거 스냅샷용 추세 요약 (mV·µV/h 단위) */
export function stackTrendEvidence(result: StackTrendResult, breakInHours: number): JsonObject {
  const { trend, xs, ys } = result;
  const first = xs[0] ?? 0;
  const last = xs[xs.length - 1] ?? 0;
  const changeIndex = trend.changeStartIndex;
  return {
    method: 'binned_residual_theil_sen',
    break_in_hours: breakInHours,
    excluded_break_in: result.excludedBreakIn,
    corrections: { slope_j_mv_per_acm2: r(result.slopeJ * 1000, 3), slope_t_mv_per_c: r(result.slopeT * 1000, 4) },
    bins: result.bins.map((b) => ({ key: b.key, n: b.n, median_v_mv: r(b.medianV * 1000, 2), op_h_min: r(b.opHoursMin, 1), op_h_max: r(b.opHoursMax, 1) })),
    trend: {
      slope_uv_per_h: r(trend.fit.slope * 1e6, 3),
      ci_low_uv_per_h: r(trend.fit.ciLow * 1e6, 3),
      ci_high_uv_per_h: r(trend.fit.ciHigh * 1e6, 3),
      mann_kendall_p: r(trend.mkPValue, 4),
      change_start_op_h: changeIndex === null ? null : r(xs[changeIndex] ?? null, 1),
      points: downsample(xs.map((x, i) => ({ op_h: r(x, 1), dv_mv: r((ys[i] ?? 0) * 1000, 3) })), 120),
      line: [first, last].map((x) => ({ op_h: r(x, 1), dv_mv: r(trendValueAt(trend.fit, x) * 1000, 3) })),
    },
  };
}

/** 앞·뒤 3분의 1 구간 중앙값 비교 (체크용). 값이 모자라면 null */
export function earlyLateMedians(values: readonly { readonly x: number; readonly y: number }[]): { early: number; late: number } | null {
  if (values.length < 6) return null;
  const xs = values.map((v) => v.x);
  const lowCut = quantile(xs, 1 / 3);
  const highCut = quantile(xs, 2 / 3);
  const early = values.filter((v) => v.x <= lowCut).map((v) => v.y);
  const late = values.filter((v) => v.x >= highCut).map((v) => v.y);
  return early.length === 0 || late.length === 0 ? null : { early: median(early), late: median(late) };
}
