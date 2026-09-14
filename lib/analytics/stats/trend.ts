// 추세: Theil–Sen 기울기 + Sen 신뢰구간, Mann–Kendall 검정 (설계 §5.3).
// 쌍 기울기가 O(n²)이므로 호출 측은 n을 수백 이하로 줄여서 넣는다 (일 중앙값·운전시간 구간 중앙값 등).
import { normalCdf, normalQuantile } from './normal';
import { median, sortedCopy } from './robust';

export interface TheilSenResult {
  readonly slope: number;
  /** median(y) − slope·median(x) (scipy.stats.theilslopes 기본 방식) */
  readonly intercept: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly n: number;
}

/** 값별 동률 묶음 크기 (2 이상인 것만) */
function tieGroupSizes(values: readonly number[]): number[] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.values()].filter((c) => c > 1);
}

const tieTerm = (sizes: readonly number[], k: number): number => sizes.reduce((sum, t) => sum + t * (t - 1) * (2 * t + k), 0);

/**
 * Theil–Sen 기울기. 신뢰구간은 Kendall 통계량 분산 기반 순위 방식 (Sen 1968, scipy.stats.theilslopes와 같다):
 *   σ² = [n(n−1)(2n+3) − Σx동률 t(t−1)(2t+3) − Σy동률 t(t−1)(2t+3)] / 18,
 *   정렬한 쌍 기울기 N개에서 round((N ± z·σ)/2)번째를 하한·상한으로 쓴다.
 * x가 같은 쌍은 기울기에서 뺀다. 유효 쌍이 없으면 오류.
 */
export function theilSen(xs: readonly number[], ys: readonly number[], alpha = 0.05): TheilSenResult {
  if (xs.length !== ys.length) throw new RangeError('theilSen: xs와 ys 길이가 다릅니다');
  const n = xs.length;
  const slopes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = (xs[j] as number) - (xs[i] as number);
      if (dx !== 0) slopes.push(((ys[j] as number) - (ys[i] as number)) / dx);
    }
  }
  if (slopes.length === 0) throw new RangeError('theilSen: x가 서로 다른 점이 2개 이상 필요합니다');
  const sorted = sortedCopy(slopes);
  const slope = median(sorted);
  const intercept = median(ys) - slope * median(xs);

  const variance = (n * (n - 1) * (2 * n + 3) - tieTerm(tieGroupSizes(xs), 3) - tieTerm(tieGroupSizes(ys), 3)) / 18;
  const spread = normalQuantile(1 - alpha / 2) * Math.sqrt(Math.max(variance, 0));
  const count = sorted.length;
  const upperIndex = Math.min(Math.round((count + spread) / 2), count - 1);
  const lowerIndex = Math.max(Math.round((count - spread) / 2) - 1, 0);
  return { slope, intercept, ciLow: sorted[lowerIndex] as number, ciHigh: sorted[upperIndex] as number, n };
}

export interface MannKendallResult {
  /** Kendall S = Σ sign(y_j − y_i), i < j */
  readonly s: number;
  /** tau-a = S / (n(n−1)/2) */
  readonly tau: number;
  readonly z: number;
  /** 양측 p값 */
  readonly pValue: number;
  readonly n: number;
}

/** Mann–Kendall 추세 검정 (동률 보정 분산, 연속성 보정 z). 점이 3개 미만이면 p = 1. */
export function mannKendall(ys: readonly number[]): MannKendallResult {
  const n = ys.length;
  if (n < 3) return { s: 0, tau: 0, z: 0, pValue: 1, n };
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) s += Math.sign((ys[j] as number) - (ys[i] as number));
  }
  const variance = (n * (n - 1) * (2 * n + 1) - tieTerm(tieGroupSizes(ys), 1)) / 18;
  const sigma = Math.sqrt(Math.max(variance, 0));
  const z = sigma === 0 || s === 0 ? 0 : (s - Math.sign(s)) / sigma;
  const pValue = z === 0 ? 1 : Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { s, tau: s / ((n * (n - 1)) / 2), z, pValue, n };
}

/** 추세선 위 x에서의 값 */
export const trendValueAt = (fit: Pick<TheilSenResult, 'slope' | 'intercept'>, x: number): number => fit.intercept + fit.slope * x;
