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

    expect(result).toEqual({ n: 4, nGood: 2, min: -2, max: 9, avg: 3, first: 1.5, last: -2, sum: 12 });
  });

  it('n_good은 quality=0인 샘플 수다 (LATE·REPROCESSED도 good이 아니다)', () => {
    const result = computeHourlyRollup([
      { tsMs: HOUR, value: 1, quality: QUALITY.REPROCESSED },
      { tsMs: HOUR + 1, value: 1, quality: QUALITY.LATE },
      { tsMs: HOUR + 2, value: 1, quality: 0 },
    ]);

    expect(result.nGood).toBe(1);
  });
});
