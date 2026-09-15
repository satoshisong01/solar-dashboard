// 스택 셀 전압 운전시간 추세 엔진 (el.voltage_rise · fc.voltage_decay 공용, 설계 §4.1 운전시간 축 열화 추적).
// 1) break-in 이후·유효 정상운전 구간을 전류밀도×온도 bin으로 나누고 bin별 중앙값을 빼서 조건 차이를 없앤다.
// 2) bin 안에 남은 전류밀도·온도 차이를 Theil–Sen 기울기로 한 번 더 보정한다.
//    정출력 운전(연료전지)처럼 열화 때문에 전류밀도·온도가 함께 움직이면 이 회귀가 열화 신호를 지우므로 끌 수 있다
//    (correctCurrentDensity·correctTemperature = false → 전류밀도 bin도 쓰지 않고, 기준 전류밀도 환산 전압과 온도 bin만 쓴다).
//    currentDensityMode = reference_slope: 전류밀도 bin 없이 앞쪽 기준 구간(break-in 이후 점의 앞 25%)에서 잰 전압–전류밀도 기울기 하나로
//    모든 점을 보정한다. 전력 설정값 운전에서 정류기·BoP 효율이 바뀌어 같은 전력의 전류밀도가 시간에 따라 옮겨 가면
//    bin 중앙값 빼기와 전체 점 회귀가 옮겨 간 만큼의 열화를 함께 지우기 때문이다.
// 3) 보정한 전압 잔차 vs 누적 운전시간 Theil–Sen(µV/h) + CI, Mann–Kendall, CUSUM.
// 4) 효과 기울기: CUSUM 변화 시작점이 있고 그 뒤 누적 운전시간이 minHoursAfterChange 이상이면 변화점 이후 점들의 Theil–Sen 기울기,
//    아니면 전체 기울기. 열화율이 도중에 바뀐 스택에서 전체 기울기가 앞 구간의 낮은 기울기에 끌려 크기를 낮게 잡는 편향을 줄인다.
//    전체·변화 전 기울기는 근거에 함께 남긴다.
import { downsample } from '../episodes/series';
import { median, quantile } from '../stats/robust';
import { theilSen, trendValueAt, type TheilSenResult } from '../stats/trend';
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
  /** 전류밀도 보정 (방식은 currentDensityMode) */
  readonly correctCurrentDensity: boolean;
  /** bins = 전류밀도 bin + bin 안 전체 점 회귀, reference_slope = bin 없이 기준 구간 기울기 하나로 보정 */
  readonly currentDensityMode: 'bins' | 'reference_slope';
  /** bin 안 온도 회귀 보정 (온도 bin은 항상 쓴다) */
  readonly correctTemperature: boolean;
  readonly minPerBin: number;
  readonly minTotal: number;
  readonly minSpanHours: number;
  readonly minCompleteness: number;
  readonly maxPoints: number;
  readonly cusumK: number;
  readonly cusumH: number;
  readonly sigmaFloorMv: number;
  /** 변화점 이후 기울기를 효과로 쓰려면 필요한 변화점 이후 누적 운전시간 [h] */
  readonly minHoursAfterChange: number;
}

export type SlopeBasis = 'full' | 'post_change';

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
  /** 운전시간 축 추세 (y = 보정 전압 잔차 [V]) — 전체 점 */
  readonly trend: TrendSummary;
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly referenceV: number;
  /** 효과에 쓴 기울기와 그 구간 (변화점 이후 또는 전체) */
  readonly basis: SlopeBasis;
  readonly effectFit: TheilSenResult;
  readonly effectFromIndex: number;
  /** 변화점 이전 점들의 기울기 (변화점 이후 기울기를 쓸 때만, 점이 모자라면 null) */
  readonly preChangeFit: TheilSenResult | null;
}

export type StackTrendOutcome = { readonly ok: true; readonly result: StackTrendResult } | { readonly ok: false; readonly reason: string };

const binKeyOf = (p: Pick<StackTrendParams, 'correctCurrentDensity' | 'currentDensityMode'>) => (pt: StackPoint): string => `${p.correctCurrentDensity && p.currentDensityMode === 'bins' ? pt.jBin : 'na'}|${pt.tBin ?? 'na'}`;

/** reference_slope 기준 구간: 운전시간 순 앞 25% (최소 minTotal개) */
const REFERENCE_SLOPE_FRACTION = 0.25;

/** 운전시간 순 앞쪽 기준 점들의 기울기 (points는 운전시간 오름차순) */
function referenceSlope(dj: readonly number[], dv: readonly number[], p: Pick<StackTrendParams, 'minTotal' | 'maxPoints'>): number {
  const n = Math.min(dj.length, Math.max(p.minTotal, Math.ceil(dj.length * REFERENCE_SLOPE_FRACTION)));
  return partialSlope(dj.slice(0, n), dv.slice(0, n), p.maxPoints);
}

/** 분산이 있는 성분만 Theil–Sen 기울기 (x가 서로 다른 값 3개 미만이면 0). 쌍 수를 줄이려고 일정 간격으로 표본을 뽑는다 */
function partialSlope(xs: readonly number[], ys: readonly number[], maxPoints: number): number {
  const pairs = downsample(xs.map((x, i) => [x, ys[i] as number] as const), maxPoints);
  if (new Set(pairs.map(([x]) => x)).size < 3) return 0;
  return theilSen(pairs.map(([x]) => x), pairs.map(([, y]) => y)).slope;
}

function groupByBin(points: readonly StackPoint[], binKey: (pt: StackPoint) => string, minPerBin: number): Map<string, StackPoint[]> {
  const groups = new Map<string, StackPoint[]>();
  for (const pt of points) groups.set(binKey(pt), [...(groups.get(binKey(pt)) ?? []), pt]);
  return new Map([...groups.entries()].filter(([, members]) => members.length >= minPerBin));
}

const fitOrNull = (xs: readonly number[], ys: readonly number[]): TheilSenResult | null => (new Set(xs).size >= 3 ? theilSen(xs, ys) : null);

/**
 * 변화점 이후 운전시간이 충분하고 변화 전·후 기울기 95% CI가 겹치지 않으면(기울기가 실제로 바뀜) 변화점 이후 기울기, 아니면 전체 기울기.
 * CUSUM은 수준 변화를 보므로 기울기가 일정한 열화에서도 변화 시작점을 내는데, 그때는 뒤쪽 점만 쓰면 잡음만 커지므로 전체 기울기를 유지한다.
 */
function effectSlope(trend: TrendSummary, xs: readonly number[], ys: readonly number[], p: StackTrendParams): Pick<StackTrendResult, 'basis' | 'effectFit' | 'effectFromIndex' | 'preChangeFit'> {
  const full = { basis: 'full' as const, effectFit: trend.fit, effectFromIndex: 0, preChangeFit: null };
  const change = trend.changeStartIndex;
  const lastX = xs[xs.length - 1] ?? 0;
  if (change === null || change <= 0 || lastX - (xs[change] ?? lastX) < p.minHoursAfterChange) return full;
  const post = fitOrNull(xs.slice(change), ys.slice(change));
  const pre = fitOrNull(xs.slice(0, change), ys.slice(0, change));
  const slopeChanged = post !== null && pre !== null && (post.ciLow > pre.ciHigh || post.ciHigh < pre.ciLow);
  return slopeChanged ? { basis: 'post_change', effectFit: post, effectFromIndex: change, preChangeFit: pre } : full;
}

/** 정상운전 점 → 운전시간 추세. 요건 미달이면 이유 */
export function stackVoltageTrend(input: readonly StackPoint[], p: StackTrendParams, direction: 'up' | 'down'): StackTrendOutcome {
  const usable = input.filter((pt) => pt.completeness >= p.minCompleteness && Number.isFinite(pt.voltage) && Number.isFinite(pt.opHours));
  const afterBreakIn = usable.filter((pt) => pt.opHours >= p.breakInHours);
  const binKey = binKeyOf(p);
  const groups = groupByBin(afterBreakIn, binKey, p.minPerBin);
  const points = [...groups.values()].flat().sort((a, b) => a.opHours - b.opHours);
  if (points.length < p.minTotal) return { ok: false, reason: `같은 조건 정상운전 구간 부족: ${points.length}개 (bin당 ${p.minPerBin}개, 합계 ${p.minTotal}개 필요, break-in ${p.breakInHours} h 이전 ${usable.length - afterBreakIn.length}개 제외)` };
  const span = (points[points.length - 1]?.opHours ?? 0) - (points[0]?.opHours ?? 0);
  if (span < p.minSpanHours) return { ok: false, reason: `누적 운전시간 범위 부족: ${span.toFixed(0)} h (${p.minSpanHours} h 필요)` };

  const centers = new Map([...groups.entries()].map(([key, members]) => [key, { v: median(members.map((m) => m.voltage)), j: median(members.map((m) => m.jMean)), t: median(members.map((m) => m.tMean ?? 0)) }]));
  const center = (pt: StackPoint) => centers.get(binKey(pt)) ?? { v: pt.voltage, j: pt.jMean, t: pt.tMean ?? 0 };
  const dv = points.map((pt) => pt.voltage - center(pt).v);
  const dj = points.map((pt) => pt.jMean - center(pt).j);
  const slopeJ = !p.correctCurrentDensity ? 0 : p.currentDensityMode === 'bins' ? partialSlope(dj, dv, p.maxPoints) : referenceSlope(dj, dv, p);
  const afterJ = dv.map((v, i) => v - slopeJ * (dj[i] as number));
  const dt = points.map((pt) => (pt.tMean ?? center(pt).t) - center(pt).t);
  const slopeT = p.correctTemperature ? partialSlope(dt, afterJ, p.maxPoints) : 0;
  const residuals = afterJ.map((v, i) => v - slopeT * (dt[i] as number));

  const grouped = groupedMedians(points.map((pt) => pt.opHours), residuals, p.maxPoints);
  const trend = summarizeTrend(grouped.xs, grouped.ys, { referenceCount: Math.max(10, Math.ceil(grouped.xs.length / 4)), sigmaFloor: p.sigmaFloorMv / 1000, direction, k: p.cusumK, h: p.cusumH });
  if (!trend) return { ok: false, reason: '운전시간이 서로 다른 점이 3개 미만입니다' };
  const bins = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, members]) => ({ key, n: members.length, medianV: median(members.map((m) => m.voltage)), opHoursMin: Math.min(...members.map((m) => m.opHours)), opHoursMax: Math.max(...members.map((m) => m.opHours)) }));
  return { ok: true, result: { points, bins, excludedBreakIn: usable.length - afterBreakIn.length, slopeJ, slopeT, trend, xs: grouped.xs, ys: grouped.ys, referenceV: bins[0]?.medianV ?? 0, ...effectSlope(trend, grouped.xs, grouped.ys, p) } };
}

const slopeJson = (fit: TheilSenResult | null): JsonObject | null => (fit === null ? null : { slope_uv_per_h: r(fit.slope * 1e6, 3), ci_low_uv_per_h: r(fit.ciLow * 1e6, 3), ci_high_uv_per_h: r(fit.ciHigh * 1e6, 3) });

/** 근거 스냅샷용 추세 요약 (mV·µV/h 단위). slope·line은 효과에 쓴 기울기(basis), full·pre_change는 비교용 */
export function stackTrendEvidence(result: StackTrendResult, breakInHours: number): JsonObject {
  const { trend, xs, ys, effectFit } = result;
  const first = xs[result.effectFromIndex] ?? 0;
  const last = xs[xs.length - 1] ?? 0;
  const changeIndex = trend.changeStartIndex;
  return {
    method: 'binned_residual_theil_sen',
    break_in_hours: breakInHours,
    excluded_break_in: result.excludedBreakIn,
    corrections: { slope_j_mv_per_acm2: r(result.slopeJ * 1000, 3), slope_t_mv_per_c: r(result.slopeT * 1000, 4) },
    bins: result.bins.map((b) => ({ key: b.key, n: b.n, median_v_mv: r(b.medianV * 1000, 2), op_h_min: r(b.opHoursMin, 1), op_h_max: r(b.opHoursMax, 1) })),
    trend: {
      basis: result.basis,
      slope_uv_per_h: r(effectFit.slope * 1e6, 3),
      ci_low_uv_per_h: r(effectFit.ciLow * 1e6, 3),
      ci_high_uv_per_h: r(effectFit.ciHigh * 1e6, 3),
      full: slopeJson(trend.fit),
      pre_change: slopeJson(result.preChangeFit),
      mann_kendall_p: r(trend.mkPValue, 4),
      change_start_op_h: changeIndex === null ? null : r(xs[changeIndex] ?? null, 1),
      points: downsample(xs.map((x, i) => ({ op_h: r(x, 1), dv_mv: r((ys[i] ?? 0) * 1000, 3) })), 120),
      line: [first, last].map((x) => ({ op_h: r(x, 1), dv_mv: r(trendValueAt(effectFit, x) * 1000, 3) })),
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
