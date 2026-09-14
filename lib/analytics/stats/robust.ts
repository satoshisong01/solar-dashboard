// 강건 통계: 중앙값·분위수·MAD·수정 z-score·Hampel 필터 (설계 §5.3 통계 도구).

/** 수정 z-score 상수 (Iglewicz & Hoaglin): M = 0.6745·(x − median)/MAD */
export const MODIFIED_Z_CONSTANT = 0.6745;
/** 정규분포에서 MAD → 표준편차 환산 계수 (1/Φ⁻¹(0.75)) */
export const MAD_TO_SIGMA = 1.4826;
/** MAD가 0일 때 평균절대편차로 대신하는 계수 (Iglewicz & Hoaglin) */
const MEAN_AD_CONSTANT = 1.253314;

function requireNonEmpty(values: readonly number[], label: string): void {
  if (values.length === 0) throw new RangeError(`${label}: 빈 배열입니다`);
}

export const sortedCopy = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** 정렬된 배열의 분위수 (선형 보간, R type 7 / numpy 기본값과 같다) */
export function quantileSorted(sorted: readonly number[], p: number): number {
  requireNonEmpty(sorted, 'quantile');
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile: p는 0~1이어야 합니다 (${p})`);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

export const quantile = (values: readonly number[], p: number): number => quantileSorted(sortedCopy(values), p);

export const median = (values: readonly number[]): number => quantile(values, 0.5);

/**
 * 가중 중앙값: 값 오름차순으로 가중치를 누적해 처음으로 전체의 절반 이상이 되는 값.
 * 누적이 정확히 절반에 닿으면 그 값과 다음 값의 평균 (가중치가 모두 같으면 median과 같다).
 * 가중치는 0 이상이어야 하고 합이 0보다 커야 한다.
 */
export function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  requireNonEmpty(values, 'weightedMedian');
  if (values.length !== weights.length) throw new RangeError('weightedMedian: 값과 가중치 길이가 다릅니다');
  if (weights.some((w) => !(w >= 0) || !Number.isFinite(w))) throw new RangeError('weightedMedian: 가중치는 0 이상 유한수여야 합니다');
  const order = values.map((value, i) => ({ value, weight: weights[i] as number })).sort((a, b) => a.value - b.value);
  const total = order.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0)) throw new RangeError('weightedMedian: 가중치 합이 0입니다');
  const half = total / 2;
  const tolerance = total * 1e-12;
  let cumulative = 0;
  for (let i = 0; i < order.length; i += 1) {
    cumulative += (order[i] as { weight: number }).weight;
    if (Math.abs(cumulative - half) <= tolerance && i + 1 < order.length) return ((order[i] as { value: number }).value + (order[i + 1] as { value: number }).value) / 2;
    if (cumulative > half) return (order[i] as { value: number }).value;
  }
  return (order[order.length - 1] as { value: number }).value;
}

export function mean(values: readonly number[]): number {
  requireNonEmpty(values, 'mean');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 중앙절대편차 (척도 보정 없음): median(|x − median(x)|) */
export function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((v) => Math.abs(v - center)));
}

export interface ModifiedZOptions {
  /** MAD 하한. 동종이 거의 같은 값이면 MAD≈0이라 작은 차이도 큰 z가 되는 것을 막는다. */
  readonly madFloor?: number;
}

/**
 * 수정 z-score 배열. |M| > 3.5를 이상치로 본다.
 * 분모 = max(MAD, madFloor). 그래도 0이면 평균절대편차(1.253314·MeanAD)로 대신하고, 그것도 0이면 전부 0.
 */
export function modifiedZ(values: readonly number[], options: ModifiedZOptions = {}): number[] {
  const center = median(values);
  const scale = Math.max(mad(values), options.madFloor ?? 0);
  if (scale > 0) return values.map((v) => (MODIFIED_Z_CONSTANT * (v - center)) / scale);
  const meanAd = mean(values.map((v) => Math.abs(v - center)));
  if (meanAd === 0) return values.map(() => 0);
  return values.map((v) => (v - center) / (MEAN_AD_CONSTANT * meanAd));
}

export interface HampelOptions {
  /** 양쪽 창 크기 (창 길이 = 2k + 1) */
  readonly halfWindow?: number;
  /** 이상치 판정 배수 (σ ≈ 1.4826·MAD) */
  readonly nSigmas?: number;
}

export interface HampelResult {
  /** 이상치를 창 중앙값으로 바꾼 새 배열 */
  readonly values: readonly number[];
  readonly outlierIndices: readonly number[];
}

/** Hampel 필터: 이동 창 중앙값에서 nSigmas·σ 넘게 벗어난 점을 그 중앙값으로 바꾼다. 창은 배열 끝에서 잘린다. */
export function hampelFilter(values: readonly number[], options: HampelOptions = {}): HampelResult {
  const halfWindow = options.halfWindow ?? 3;
  const nSigmas = options.nSigmas ?? 3;
  const outlierIndices: number[] = [];
  const filtered = values.map((value, i) => {
    const window = values.slice(Math.max(0, i - halfWindow), Math.min(values.length, i + halfWindow + 1));
    const center = median(window);
    const sigma = MAD_TO_SIGMA * mad(window);
    if (sigma > 0 && Math.abs(value - center) > nSigmas * sigma) {
      outlierIndices.push(i);
      return center;
    }
    return value;
  });
  return { values: filtered, outlierIndices };
}
