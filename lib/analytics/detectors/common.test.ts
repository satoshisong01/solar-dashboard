import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { dailyMedians, fixed, groupedMedians, hoursKo, r, severityByMagnitude, signed, summarizeTrend } from './common';

describe('표기 도우미', () => {
  it('signed·fixed·hoursKo·r', () => {
    expect(signed(-6.25, 1)).toBe('-6.3');
    expect(signed(2.04, 1)).toBe('+2.0');
    expect(signed(-0.01, 1)).toBe('0.0');
    expect(signed(0, 1)).toBe('0.0');
    expect(fixed(12345.678, 1)).toBe('12,345.7');
    expect(fixed(-1234, 0)).toBe('-1,234');
    expect(hoursKo(8)).toBe('8시간 0분');
    expect(hoursKo(7.5)).toBe('7시간 30분');
    expect(r(-0.00001, 3)).toBe(0);
    expect(r(null)).toBeNull();
    expect(r(Number.NaN)).toBeNull();
  });

  it('severityByMagnitude는 큰 임계부터 비교한다', () => {
    const thresholds = [[10, 2], [40, 4], [20, 3]] as const;
    expect(severityByMagnitude(25, thresholds)).toBe(3);
    expect(severityByMagnitude(40, thresholds)).toBe(4);
    expect(severityByMagnitude(9.9, thresholds)).toBeNull();
  });
});

describe('축약·추세 요약', () => {
  it('dailyMedians는 KST 날짜별 중앙값', () => {
    const t = Date.UTC(2026, 0, 1, 0); // KST 09시
    const result = dailyMedians([
      { ts: t, value: 1 },
      { ts: t + 2 * MS_PER_HOUR, value: 3 },
      { ts: t + 16 * MS_PER_HOUR, value: 10 }, // KST 다음날 01시
    ]);
    expect(result.map((d) => d.value)).toEqual([2, 10]);
    expect(result[1]?.ts).toBe((result[0]?.ts ?? 0) + MS_PER_DAY);
  });

  it('groupedMedians는 구간 수를 줄이고 적으면 그대로', () => {
    expect(groupedMedians([1, 2], [3, 4], 5)).toEqual({ xs: [1, 2], ys: [3, 4] });
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const grouped = groupedMedians(xs, xs.map((x) => 2 * x), 10);
    expect(grouped.xs).toHaveLength(10);
    grouped.xs.forEach((x, i) => expect(grouped.ys[i]).toBeCloseTo(2 * x, 9));
  });

  it('summarizeTrend: 점이 모자라면 null, 계단 감소면 CUSUM 경보', () => {
    expect(summarizeTrend([1, 1, 2], [1, 2, 3], { referenceCount: 3, sigmaFloor: 0.1, direction: 'down', k: 0.5, h: 5 })).toBeNull();
    const xs = Array.from({ length: 40 }, (_, i) => i);
    const ys = xs.map((x) => (x < 20 ? 100 + (x % 2) * 0.1 : 97));
    const summary = summarizeTrend(xs, ys, { referenceCount: 20, sigmaFloor: 0.1, direction: 'down', k: 0.5, h: 5 });
    expect(summary?.changeStartIndex).toBe(20);
    expect(summary?.fit.slope).toBeLessThan(0);
    expect(summary?.mkTau).toBeLessThan(0);
  });
});
