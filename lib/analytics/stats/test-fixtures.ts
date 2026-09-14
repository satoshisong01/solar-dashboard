// stats 테스트용 결정적 표본 생성기.
import { createRng } from '@/lib/sim/rng';

/** 평균 mu, 표준편차 sigma 정규 표본 (seed 고정) */
export function normalSample(n: number, mu: number, sigma: number, seed: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => mu + sigma * rng.gaussian());
}
