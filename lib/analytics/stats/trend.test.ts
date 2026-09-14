import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { normalCdf, normalQuantile } from './normal';
import { mannKendall, theilSen, trendValueAt } from './trend';

describe('normalCdf / normalQuantile', () => {
  it('알려진 값', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 6);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
  });

  it('역함수 관계와 범위 오류', () => {
    for (const p of [0.001, 0.02, 0.3, 0.5, 0.8, 0.99]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('theilSen', () => {
  it('알려진 값: 이상치 하나에 강건하고 Sen CI는 scipy.stats.theilslopes와 같다', () => {
    const fit = theilSen([1, 2, 3, 4, 5], [1, 2, 3, 4, 10]);
    expect(fit.slope).toBe(1);
    expect(fit.intercept).toBe(0);
    expect(fit.ciLow).toBe(1);
    expect(fit.ciHigh).toBe(6);
    expect(fit.n).toBe(5);
  });

  it('잡음 없는 직선은 기울기·절편을 정확히 찾고 CI 폭이 0', () => {
    const xs = Array.from({ length: 40 }, (_, i) => i * 2.5);
    const fit = theilSen(xs, xs.map((x) => 7 - 0.3 * x));
    expect(fit.slope).toBeCloseTo(-0.3, 12);
    expect(fit.intercept).toBeCloseTo(7, 10);
    expect(fit.ciLow).toBeCloseTo(-0.3, 12);
    expect(fit.ciHigh).toBeCloseTo(-0.3, 12);
    expect(trendValueAt(fit, 10)).toBeCloseTo(4, 10);
  });

  it('성질: 잡음이 있어도 CI가 참 기울기를 포함하고 x가 같은 쌍은 무시한다', () => {
    const rng = createRng(21);
    const xs = Array.from({ length: 60 }, (_, i) => Math.floor(i / 2));
    const ys = xs.map((x) => 2 + 0.05 * x + 0.2 * rng.gaussian());
    const fit = theilSen(xs, ys);
    expect(fit.ciLow).toBeLessThan(0.05);
    expect(fit.ciHigh).toBeGreaterThan(0.05);
    expect(fit.ciLow).toBeLessThanOrEqual(fit.slope);
    expect(fit.ciHigh).toBeGreaterThanOrEqual(fit.slope);
  });

  it('길이가 다르거나 x가 모두 같으면 오류', () => {
    expect(() => theilSen([1, 2], [1])).toThrow(RangeError);
    expect(() => theilSen([3, 3, 3], [1, 2, 3])).toThrow(RangeError);
  });
});

describe('mannKendall', () => {
  it('알려진 값: 단조 증가 5점 → S=10, tau=1, p≈0.0100', () => {
    const result = mannKendall([1, 2, 3, 4, 5]);
    expect(result.s).toBe(10);
    expect(result.tau).toBe(1);
    expect(result.z).toBeCloseTo(9 / Math.sqrt(220 / 18), 10);
    expect(result.pValue).toBeCloseTo(0.01005, 4);
  });

  it('동률 보정과 감소 추세 부호', () => {
    const result = mannKendall([5, 5, 4, 3, 3, 1]);
    expect(result.s).toBeLessThan(0);
    expect(result.z).toBeLessThan(0);
    // 동률 {5,5},{3,3} 보정: var = (6·5·13 − 2·(2·1·5))/18
    expect(result.z).toBeCloseTo((result.s + 1) / Math.sqrt((390 - 20) / 18), 10);
  });

  it('점이 3개 미만이거나 변화가 없으면 p=1', () => {
    expect(mannKendall([1, 2]).pValue).toBe(1);
    expect(mannKendall([4, 4, 4, 4]).pValue).toBe(1);
  });
});
