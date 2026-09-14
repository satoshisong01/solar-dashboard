import { describe, expect, it } from 'vitest';
import { counterIncrease, hourlyAverageEnergy, sumNullable, type HourBucket } from './energy-calc';
import { kstDayStartMs, kstMonthStartMs, yesterdayAndToday } from './time';

const H = 3_600_000;
const T0 = Date.parse('2026-09-13T15:00:00Z'); // 2026-09-14 00:00 KST
const window = { fromMs: T0, toMs: T0 + 3 * H };

const bucket = (hour: number, first: number | null, last: number | null, avg: number | null = null): HourBucket => ({
  bucketMs: T0 + hour * H,
  first,
  last,
  avg,
});

describe('counterIncrease', () => {
  it('직전 버킷의 마지막 값을 기준으로 버킷 사이 틈까지 포함해 더한다', () => {
    const buckets = [bucket(-1, 90, 100), bucket(0, 101, 110), bucket(1, 111, 125), bucket(2, 126, 130)];
    expect(counterIncrease(buckets, window)).toBe(30);
  });

  it('직전 버킷이 없으면 구간 첫 버킷의 첫 값을 기준으로 한다', () => {
    expect(counterIncrease([bucket(0, 100, 110), bucket(1, 111, 120)], window)).toBe(20);
  });

  it('입력 순서와 무관하고, 구간 뒤 버킷은 넣지 않는다', () => {
    const buckets = [bucket(3, 200, 300), bucket(1, 111, 120), bucket(-1, 90, 100), bucket(0, 101, 110)];
    expect(counterIncrease(buckets, window)).toBe(20);
  });

  it('중간 시간이 비어도 카운터 차이로 이어서 계산한다', () => {
    expect(counterIncrease([bucket(-1, 0, 100), bucket(2, 150, 160)], window)).toBe(60);
  });

  it('카운터가 줄어든 단계(리셋)는 0으로 본다', () => {
    expect(counterIncrease([bucket(-1, 0, 100), bucket(0, 101, 110), bucket(1, 0, 5), bucket(2, 6, 9)], window)).toBe(14);
  });

  it('구간에 값이 없으면 null', () => {
    expect(counterIncrease([bucket(-1, 0, 100)], window)).toBeNull();
    expect(counterIncrease([bucket(0, null, null)], window)).toBeNull();
  });
});

describe('hourlyAverageEnergy', () => {
  it('시간 평균 kW × 1시간을 더하고 결측 버킷은 건너뛴다', () => {
    const buckets = [bucket(-1, null, null, 999), bucket(0, null, null, 100), bucket(1, null, null, null), bucket(2, null, null, 50.5)];
    expect(hourlyAverageEnergy(buckets, window)).toBe(150.5);
  });

  it('구간에 값이 없으면 null', () => {
    expect(hourlyAverageEnergy([bucket(5, null, null, 10)], window)).toBeNull();
  });
});

describe('sumNullable', () => {
  it('null을 빼고 더하며 모두 null이면 null', () => {
    expect(sumNullable([1, null, 2.5])).toBe(3.5);
    expect(sumNullable([null, null])).toBeNull();
    expect(sumNullable([])).toBeNull();
  });
});

describe('KST 경계', () => {
  const now = Date.parse('2026-09-14T11:34:00Z'); // 20:34 KST

  it('오늘 00:00 KST와 어제 구간', () => {
    expect(new Date(kstDayStartMs(now)).toISOString()).toBe('2026-09-13T15:00:00.000Z');
    expect(yesterdayAndToday(now)).toEqual({
      yesterday: { fromMs: Date.parse('2026-09-12T15:00:00Z'), toMs: Date.parse('2026-09-13T15:00:00Z') },
      today: { fromMs: Date.parse('2026-09-13T15:00:00Z'), toMs: now },
    });
  });

  it('UTC로는 전날이어도 KST 날짜 기준으로 자른다', () => {
    const earlyKst = Date.parse('2026-09-13T16:00:00Z'); // 09-14 01:00 KST
    expect(new Date(kstDayStartMs(earlyKst)).toISOString()).toBe('2026-09-13T15:00:00.000Z');
  });

  it('이번 달 1일 00:00 KST', () => {
    expect(new Date(kstMonthStartMs(now)).toISOString()).toBe('2026-08-31T15:00:00.000Z');
    expect(new Date(kstMonthStartMs(Date.parse('2026-08-31T15:30:00Z'))).toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });
});
