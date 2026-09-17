import { describe, expect, it } from 'vitest';
import { counterIncrease, hourlyAverageEnergy, ratedPerHour, sumEnergyResults, sumNullable, type HourBucket } from './energy-calc';
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
    expect(counterIncrease(buckets, window)).toEqual({ value: 30, suspect: false, standby: 0 });
  });

  it('직전 버킷이 없으면 구간 첫 버킷의 첫 값을 기준으로 한다', () => {
    expect(counterIncrease([bucket(0, 100, 110), bucket(1, 111, 120)], window).value).toBe(20);
  });

  it('입력 순서와 무관하고, 구간 뒤 버킷은 넣지 않는다', () => {
    const buckets = [bucket(3, 200, 300), bucket(1, 111, 120), bucket(-1, 90, 100), bucket(0, 101, 110)];
    expect(counterIncrease(buckets, window).value).toBe(20);
  });

  it('중간 시간이 비어도 카운터 차이로 이어서 계산한다', () => {
    expect(counterIncrease([bucket(-1, 0, 100), bucket(2, 150, 160)], window).value).toBe(60);
  });

  it('카운터가 줄어든 단계(리셋)는 0으로 본다', () => {
    expect(counterIncrease([bucket(-1, 0, 100), bucket(0, 101, 110), bucket(1, 0, 5), bucket(2, 6, 9)], window).value).toBe(14);
  });

  it('구간에 값이 없으면 null', () => {
    expect(counterIncrease([bucket(-1, 0, 100)], window).value).toBeNull();
    expect(counterIncrease([bucket(0, null, null)], window).value).toBeNull();
  });
});

describe('counterIncrease 정격 상한', () => {
  it('정격으로 설명되지 않는 점프는 더하지 않고 의심으로 알린다', () => {
    // 1,000 kW PCS: 한 시간 버킷 사이 최대 2,000 kWh(간격 1시간 + 샘플 자리 1시간)
    const buckets = [bucket(-1, 581_000, 581_905.9), bucket(0, 581_905.9, 581_905.9), bucket(1, 608_967.8, 608_967.8)];
    expect(counterIncrease(buckets, window, 1_000)).toEqual({ value: 0, suspect: true, standby: 0 });
    expect(counterIncrease(buckets, window).value).toBeCloseTo(27_061.9, 1);
  });

  it('정격 안의 증가는 그대로 더하고 의심으로 보지 않는다', () => {
    const buckets = [bucket(-1, 0, 100), bucket(0, 100, 900), bucket(1, 900, 1_700), bucket(2, 1_700, 2_400)];
    expect(counterIncrease(buckets, window, 1_000)).toEqual({ value: 2_300, suspect: false, standby: 0 });
  });

  it('버킷이 비어 있던 만큼은 상한도 같이 늘어난다 (10시간 뒤 버킷은 10시간치를 담는다)', () => {
    const gap = [bucket(-1, 0, 100), bucket(10, 100, 9_000)];
    const long = { fromMs: T0, toMs: T0 + 12 * H };
    expect(counterIncrease(gap, long, 1_000)).toEqual({ value: 8_900, suspect: false, standby: 0 });
    expect(counterIncrease(gap, long, 500).suspect).toBe(true);
  });

  it('상한을 주지 않으면 예전처럼 증가분을 모두 더한다', () => {
    expect(counterIncrease([bucket(-1, 0, 0), bucket(0, 0, 99_999)], window, null).value).toBe(99_999);
  });
});

describe('hourlyAverageEnergy', () => {
  it('시간 평균 kW × 1시간을 더하고 결측 버킷은 건너뛴다', () => {
    const buckets = [bucket(-1, null, null, 999), bucket(0, null, null, 100), bucket(1, null, null, null), bucket(2, null, null, 50.5)];
    expect(hourlyAverageEnergy(buckets, window)).toEqual({ value: 150.5, suspect: false, standby: 0 });
  });

  it('정지 중 대기 소비(음수 평균)는 발전량에 넣지 않고 따로 센다', () => {
    const buckets = [bucket(0, null, null, -0.5), bucket(1, null, null, -0.5), bucket(2, null, null, 150)];
    expect(hourlyAverageEnergy(buckets, window)).toEqual({ value: 150, suspect: false, standby: 1 });
  });

  it('하루 종일 정지면 발전량은 0이고 대기 소비만 남는다', () => {
    const buckets = [bucket(0, null, null, -0.5), bucket(1, null, null, -0.5), bucket(2, null, null, -0.5)];
    expect(hourlyAverageEnergy(buckets, window)).toEqual({ value: 0, suspect: false, standby: 1.5 });
  });

  it('구간에 값이 없으면 null', () => {
    expect(hourlyAverageEnergy([bucket(5, null, null, 10)], window).value).toBeNull();
  });
});

describe('sumEnergyResults', () => {
  it('설비별 값을 더하고, 하나라도 의심이면 의심으로 남긴다', () => {
    expect(sumEnergyResults([{ value: 10, suspect: false, standby: 0 }, { value: null, suspect: true, standby: 2 }])).toEqual({ value: 10, suspect: true, standby: 2 });
  });

  it('모두 값이 없으면 null', () => {
    expect(sumEnergyResults([{ value: null, suspect: false, standby: 0 }]).value).toBeNull();
  });
});

describe('ratedPerHour', () => {
  it('KPI마다 정해진 명판 키에서 시간당 최대 증가량을 읽는다', () => {
    expect(ratedPerHour({ power_kw: 1_000 }, 'essChargeKwh')).toBe(1_000);
    expect(ratedPerHour({ ac_kw: 500, dc_kwp: 500 }, 'pvKwh')).toBe(500);
    expect(ratedPerHour({ h2_rated_kg_h: 44.9 }, 'h2Kg')).toBe(44.9);
  });

  it('명판이 없거나 값이 양수가 아니면 상한을 두지 않는다', () => {
    expect(ratedPerHour(null, 'pvKwh')).toBeNull();
    expect(ratedPerHour({ ac_kw: 0 }, 'pvKwh')).toBeNull();
    expect(ratedPerHour({ ac_kw: 'x' }, 'pvKwh')).toBeNull();
    expect(ratedPerHour({ power_kw: 1_000 }, 'fcKwh')).toBeNull();
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
