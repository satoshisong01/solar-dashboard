import { describe, expect, it } from 'vitest';
import { extraRateHook, levelRampHook, linearGrowthHook, rampFraction, rateFromHook } from './degradation';
import { MS_PER_DAY } from './math';

const T0 = Date.parse('2026-05-01T00:00:00+09:00');

describe('열화 hook 시간 함수', () => {
  it('rampFraction: 시작 전 0, 램프 동안 선형, 이후 1. 램프 0이면 시작 시각에 계단', () => {
    expect([T0 - 1, T0, T0 + 5 * MS_PER_DAY, T0 + 10 * MS_PER_DAY, T0 + 20 * MS_PER_DAY].map((t) => rampFraction(t, T0, 10 * MS_PER_DAY))).toEqual([0, 0, 0.5, 1, 1]);
    expect([T0 - 1, T0].map((t) => rampFraction(t, T0, 0))).toEqual([0, 1]);
  });

  it('levelRampHook: 기본값 위에 크기를 램프로 더하고 유지한다', () => {
    const hook = levelRampHook(T0, 4 * MS_PER_DAY, 0.02);

    expect(hook(T0 - 1, 0.001)).toBe(0.001);
    expect(hook(T0 + MS_PER_DAY, 0.001)).toBeCloseTo(0.006, 12);
    expect(hook(T0 + 30 * MS_PER_DAY, 0.001)).toBeCloseTo(0.021, 12);
  });

  it('linearGrowthHook: 시작일부터 하루 perDay씩 끝없이 커진다', () => {
    const hook = linearGrowthHook(T0, 0.5);

    expect(hook(T0 - MS_PER_DAY, 2)).toBe(2);
    expect(hook(T0 + 10 * MS_PER_DAY, 2)).toBeCloseTo(7, 12);
  });

  it('extraRateHook: 구간 안에서만 기본 율에 추가 율을 더한다', () => {
    const hook = extraRateHook(T0, T0 + 30 * MS_PER_DAY, 0.001);

    expect([T0 - 1, T0, T0 + 30 * MS_PER_DAY - 1, T0 + 30 * MS_PER_DAY].map((t) => hook(t, 0.00005))).toEqual([0.00005, 0.00105, 0.00105, 0.00005]);
  });

  it('rateFromHook: 시작일부터 기본 율을 지정한 율로 바꾼다', () => {
    const hook = rateFromHook(T0, 25);

    expect([hook(T0 - 1, 4), hook(T0, 4)]).toEqual([4, 25]);
  });
});
