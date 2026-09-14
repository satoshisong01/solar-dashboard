// 변화 시점: 표 CUSUM (k=0.5, h=4~5), EWMA (설계 §5.3).
import { MAD_TO_SIGMA, mad, median } from './robust';

export type CusumDirection = 'up' | 'down' | 'both';

export interface CusumOptions {
  /** 허용 편차 (표준화 단위) */
  readonly k?: number;
  /** 결정 경계 (표준화 단위) */
  readonly h?: number;
  readonly direction?: CusumDirection;
}

export interface CusumResult {
  /** 누적합이 h를 처음 넘은 인덱스. 없으면 null */
  readonly alarmIndex: number | null;
  /** 경보를 낸 누적합이 0에서 올라가기 시작한 인덱스 (변화 시작 추정). 없으면 null */
  readonly changeStartIndex: number | null;
  readonly direction: 'up' | 'down' | null;
  readonly maxUpper: number;
  readonly maxLower: number;
}

/**
 * 표 CUSUM (표준화 잔차 입력): S⁺ᵢ = max(0, S⁺ᵢ₋₁ + zᵢ − k), S⁻ᵢ = max(0, S⁻ᵢ₋₁ − zᵢ − k).
 * 첫 경보에서 멈춘다. 변화 시작 = 그 누적합이 마지막으로 0이었던 다음 인덱스.
 */
export function cusum(residuals: readonly number[], options: CusumOptions = {}): CusumResult {
  const k = options.k ?? 0.5;
  const h = options.h ?? 5;
  const direction = options.direction ?? 'both';
  let upper = 0;
  let lower = 0;
  let upperStart = 0;
  let lowerStart = 0;
  let maxUpper = 0;
  let maxLower = 0;
  for (let i = 0; i < residuals.length; i += 1) {
    const z = residuals[i] as number;
    if (upper === 0) upperStart = i;
    if (lower === 0) lowerStart = i;
    upper = Math.max(0, upper + z - k);
    lower = Math.max(0, lower - z - k);
    maxUpper = Math.max(maxUpper, upper);
    maxLower = Math.max(maxLower, lower);
    if (direction !== 'down' && upper > h) return { alarmIndex: i, changeStartIndex: upperStart, direction: 'up', maxUpper, maxLower };
    if (direction !== 'up' && lower > h) return { alarmIndex: i, changeStartIndex: lowerStart, direction: 'down', maxUpper, maxLower };
  }
  return { alarmIndex: null, changeStartIndex: null, direction: null, maxUpper, maxLower };
}

/** 기준 구간의 중앙값·σ(1.4826·MAD, 하한 sigmaFloor)로 표준화한 새 배열. σ가 0이면 오류 (sigmaFloor를 지정할 것) */
export function standardize(values: readonly number[], reference: readonly number[], sigmaFloor = 0): number[] {
  const center = median(reference);
  const sigma = Math.max(MAD_TO_SIGMA * mad(reference), sigmaFloor);
  if (!(sigma > 0)) throw new RangeError('standardize: 기준 구간 σ가 0입니다 (sigmaFloor를 지정하세요)');
  return values.map((v) => (v - center) / sigma);
}

/** EWMA zᵢ = λ·xᵢ + (1−λ)·zᵢ₋₁, z₋₁ = initial (기본: 첫 값) */
export function ewma(values: readonly number[], lambda: number, initial?: number): number[] {
  if (!(lambda > 0 && lambda <= 1)) throw new RangeError(`ewma: λ는 (0, 1] 이어야 합니다 (${lambda})`);
  if (values.length === 0) return [];
  let previous = initial ?? (values[0] as number);
  return values.map((x) => {
    previous = lambda * x + (1 - lambda) * previous;
    return previous;
  });
}
