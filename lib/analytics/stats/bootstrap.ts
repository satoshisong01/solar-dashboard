// 부트스트랩 백분위 신뢰구간. 난수는 반드시 주입한다 (같은 시드 → 같은 결과).
import type { RandomSource } from '../types';
import { quantileSorted, sortedCopy } from './robust';

export interface BootstrapOptions {
  readonly iterations?: number;
  readonly alpha?: number;
  readonly rng: RandomSource;
}

export interface BootstrapResult {
  /** 원 표본의 통계량 */
  readonly estimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly iterations: number;
}

/** 복원추출로 같은 크기의 새 표본 */
export function resample<T>(sample: readonly T[], rng: RandomSource): T[] {
  return sample.map(() => sample[Math.floor(rng.next() * sample.length)] as T);
}

function percentileInterval(estimate: number, stats: readonly number[], alpha: number, iterations: number): BootstrapResult {
  const finite = sortedCopy(stats.filter(Number.isFinite));
  if (finite.length === 0) return { estimate, ciLow: Number.NaN, ciHigh: Number.NaN, iterations };
  return { estimate, ciLow: quantileSorted(finite, alpha / 2), ciHigh: quantileSorted(finite, 1 - alpha / 2), iterations };
}

function readOptions(options: BootstrapOptions): { iterations: number; alpha: number } {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  if (!(Number.isInteger(iterations) && iterations > 0)) throw new RangeError(`bootstrap: iterations는 양의 정수 (${iterations})`);
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`bootstrap: alpha는 (0, 1) (${alpha})`);
  return { iterations, alpha };
}

/** 한 표본 통계량의 백분위 부트스트랩 CI */
export function bootstrapCI<T>(sample: readonly T[], statFn: (s: readonly T[]) => number, options: BootstrapOptions): BootstrapResult {
  if (sample.length === 0) throw new RangeError('bootstrapCI: 빈 표본입니다');
  const { iterations, alpha } = readOptions(options);
  const stats = Array.from({ length: iterations }, () => statFn(resample(sample, options.rng)));
  return percentileInterval(statFn(sample), stats, alpha, iterations);
}

/** 두 표본을 각각 복원추출하는 통계량(예: 중앙값 차)의 백분위 부트스트랩 CI */
export function bootstrapTwoSampleCI<A, B>(
  a: readonly A[],
  b: readonly B[],
  statFn: (a: readonly A[], b: readonly B[]) => number,
  options: BootstrapOptions,
): BootstrapResult {
  if (a.length === 0 || b.length === 0) throw new RangeError('bootstrapTwoSampleCI: 빈 표본입니다');
  const { iterations, alpha } = readOptions(options);
  const stats = Array.from({ length: iterations }, () => statFn(resample(a, options.rng), resample(b, options.rng)));
  return percentileInterval(statFn(a, b), stats, alpha, iterations);
}
