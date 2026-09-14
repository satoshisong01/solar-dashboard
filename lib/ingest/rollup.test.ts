import { describe, expect, it } from 'vitest';
import { QUALITY } from './quality';
import { computeHourlyRollup, hourBucket } from './rollup';

const HOUR = Date.UTC(2026, 8, 14, 3);

describe('hourBucket', () => {
  it('UTC 시간 시작으로 내린다', () => {
    expect(hourBucket(HOUR)).toBe(HOUR);
    expect(hourBucket(HOUR + 3_599_999)).toBe(HOUR);
    expect(hourBucket(HOUR + 3_600_000)).toBe(HOUR + 3_600_000);
  });
});

describe('computeHourlyRollup', () => {
  it('샘플이 없으면 n=0과 null 통계', () => {
    expect(computeHourlyRollup([])).toEqual({ n: 0, nGood: 0, min: null, max: null, avg: null, first: null, last: null, sum: null });
  });

  it('도착 순서와 무관하게 시각 순으로 first/last를 정하고 min/max/avg/sum을 계산한다', () => {
    const result = computeHourlyRollup([
      { tsMs: HOUR + 600_000, value: 3.5, quality: 0 },
      { tsMs: HOUR, value: 1.5, quality: 0 },
      { tsMs: HOUR + 1_200_000, value: -2, quality: QUALITY.LATE },
      { tsMs: HOUR + 300_000, value: 9, quality: QUALITY.HARD_RANGE },
    ]);

    expect(result).toEqual({ n: 4, nGood: 3, min: -2, max: 9, avg: 3, first: 1.5, last: -2, sum: 12 });
  });

  it('n_good은 BAD 비트가 없는 샘플 수다 (LATE·REPROCESSED·CLOCK_SUSPECT만 있으면 good)', () => {
    const result = computeHourlyRollup([
      { tsMs: HOUR, value: 1, quality: QUALITY.REPROCESSED },
      { tsMs: HOUR + 1, value: 1, quality: QUALITY.LATE },
      { tsMs: HOUR + 2, value: 1, quality: QUALITY.CLOCK_SUSPECT | QUALITY.LATE },
      { tsMs: HOUR + 3, value: 1, quality: 0 },
      { tsMs: HOUR + 4, value: 1, quality: QUALITY.DEVICE_BAD },
      { tsMs: HOUR + 5, value: 1, quality: QUALITY.SPIKE | QUALITY.LATE },
      { tsMs: HOUR + 6, value: 1, quality: QUALITY.FLATLINE },
    ]);

    expect(result.nGood).toBe(4);
  });

  it('값이 NULL인 행은 n에만 들어가고 n_good·min/max/avg/sum·first/last에서 빠진다', () => {
    const result = computeHourlyRollup([
      { tsMs: HOUR, value: null, quality: 0 },
      { tsMs: HOUR + 60_000, value: 2, quality: 0 },
      { tsMs: HOUR + 120_000, value: 4, quality: QUALITY.LATE },
      { tsMs: HOUR + 180_000, value: null, quality: QUALITY.LATE },
    ]);

    expect(result).toEqual({ n: 4, nGood: 2, min: 2, max: 4, avg: 3, first: 2, last: 4, sum: 6 });
  });

  it('값이 모두 NULL이면 n만 세고 값 통계는 모두 null', () => {
    const result = computeHourlyRollup([
      { tsMs: HOUR, value: null, quality: 0 },
      { tsMs: HOUR + 1, value: null, quality: QUALITY.DEVICE_BAD },
    ]);

    expect(result).toEqual({ n: 2, nGood: 0, min: null, max: null, avg: null, first: null, last: null, sum: null });
  });
});
