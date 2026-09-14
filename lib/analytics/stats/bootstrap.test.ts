import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { bootstrapCI, bootstrapTwoSampleCI, resample } from './bootstrap';
import { normalSample } from './test-fixtures';
import { mean, median } from './robust';

describe('resample', () => {
  it('같은 크기, 원 표본의 원소만 쓴다', () => {
    const sample = [1, 2, 3, 4];
    const drawn = resample(sample, createRng(1));
    expect(drawn).toHaveLength(4);
    drawn.forEach((v) => expect(sample).toContain(v));
  });
});

describe('bootstrapCI', () => {
  it('상수 표본은 CI 폭이 0', () => {
    const result = bootstrapCI([3, 3, 3, 3], median, { rng: createRng(2), iterations: 200 });
    expect(result).toEqual({ estimate: 3, ciLow: 3, ciHigh: 3, iterations: 200 });
  });

  it('성질: 정규 표본 평균의 95% CI는 참값을 포함하고 폭이 이론값(±1.96σ/√n)에 가깝다', () => {
    const sample = normalSample(400, 10, 2, 5);
    const result = bootstrapCI(sample, mean, { rng: createRng(8), iterations: 2000 });
    expect(result.ciLow).toBeLessThan(10);
    expect(result.ciHigh).toBeGreaterThan(10);
    const theoretical = 2 * 1.96 * (2 / Math.sqrt(400));
    expect(result.ciHigh - result.ciLow).toBeGreaterThan(theoretical * 0.8);
    expect(result.ciHigh - result.ciLow).toBeLessThan(theoretical * 1.2);
  });

  it('결정성: 같은 시드 → 같은 결과', () => {
    const sample = normalSample(50, 0, 1, 4);
    const a = bootstrapCI(sample, median, { rng: createRng(99) });
    const b = bootstrapCI(sample, median, { rng: createRng(99) });
    expect(a).toEqual(b);
  });

  it('빈 표본·잘못된 옵션은 오류, 통계량이 전부 NaN이면 CI NaN', () => {
    expect(() => bootstrapCI([], median, { rng: createRng(1) })).toThrow(RangeError);
    expect(() => bootstrapCI([1], median, { rng: createRng(1), iterations: 0 })).toThrow(RangeError);
    expect(() => bootstrapCI([1], median, { rng: createRng(1), alpha: 1 })).toThrow(RangeError);
    const nan = bootstrapCI([1, 2], () => Number.NaN, { rng: createRng(1), iterations: 5 });
    expect(Number.isNaN(nan.ciLow)).toBe(true);
  });
});

describe('bootstrapTwoSampleCI', () => {
  it('중앙값 차 CI가 참 차이를 포함한다', () => {
    const a = normalSample(80, 20, 1, 6);
    const b = normalSample(80, 17, 1, 7);
    const result = bootstrapTwoSampleCI(a, b, (x, y) => median(x) - median(y), { rng: createRng(4) });
    expect(result.estimate).toBeCloseTo(3, 0);
    expect(result.ciLow).toBeLessThan(3);
    expect(result.ciHigh).toBeGreaterThan(3);
    expect(() => bootstrapTwoSampleCI([], b, () => 0, { rng: createRng(1) })).toThrow(RangeError);
  });
});
