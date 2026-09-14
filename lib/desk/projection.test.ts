import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '@/lib/analytics/types';
import { effectCiDigits, formatEffectWithCi } from './effect';
import { pendingProjectionText, projectionOf } from './projection';

const T0 = Date.UTC(2026, 0, 1);
const base = { estimate: T0 + 800 * MS_PER_DAY, early: T0 + 600 * MS_PER_DAY, late: T0 + 1_200 * MS_PER_DAY, slopeCiHigh: -0.8, firstTs: T0, lastTs: T0 + 90 * MS_PER_DAY, minSpanDays: 60 };

describe('SOH 도달일 외삽 가드', () => {
  it('데이터 60일 이상·기울기 CI 상한 < 0·10년 이내면 날짜', () => {
    expect(projectionOf(base)).toEqual({ kind: 'date', estimate: base.estimate, early: base.early, late: base.late, spanDays: 90 });
  });

  it('데이터 기간 부족·유의하지 않은 기울기·10년 넘는 예상·예상 없음이면 추세 확인 중(데이터 N일)', () => {
    expect(projectionOf({ ...base, lastTs: T0 + 45 * MS_PER_DAY })).toEqual({ kind: 'pending', spanDays: 45 });
    expect(projectionOf({ ...base, slopeCiHigh: 0.1 })).toMatchObject({ kind: 'pending' });
    expect(projectionOf({ ...base, estimate: T0 + 90 * MS_PER_DAY + 11 * 365.25 * MS_PER_DAY })).toMatchObject({ kind: 'pending' });
    expect(projectionOf({ ...base, estimate: null })).toMatchObject({ kind: 'pending' });
    expect(projectionOf({ ...base, firstTs: null })).toBeNull();
    // 근거에 최소 기간이 없으면(예전 스냅샷) 탐지기 기본값 60일
    expect(projectionOf({ ...base, minSpanDays: null, lastTs: T0 + 59 * MS_PER_DAY })).toMatchObject({ kind: 'pending', spanDays: 59 });
    expect(pendingProjectionText(45)).toBe('추세 확인 중(데이터 45일)');
  });
});

describe('formatEffectWithCi', () => {
  it('점추정과 CI 경계가 같은 글자로 보이면 자릿수를 늘리고(최대 3자리), 다르면 그대로', () => {
    expect(formatEffectWithCi({ value: -7.396, unit: '%', ciLow: -7.467, ciHigh: -7.218 })).toEqual({ value: '−7.4%', ci: '95% CI −7.5 ~ −7.2', digits: 1 });
    expect(formatEffectWithCi({ value: -7.396, unit: '%', ciLow: -7.43, ciHigh: -7.38 })).toEqual({ value: '−7.4%', ci: '95% CI −7.43 ~ −7.38', digits: 2 });
    expect(formatEffectWithCi({ value: 21.4321, unit: 'µV/h', ciLow: 21.4304, ciHigh: 21.44 }, 1)).toEqual({ value: '+21.432 µV/h', ci: '95% CI +21.43 ~ +21.44', digits: 3 });
    expect(effectCiDigits({ value: 1, ciLow: 1, ciHigh: 1 }, 1)).toBe(3);
    expect(effectCiDigits({ value: null, ciLow: 1, ciHigh: 2 }, 2)).toBe(2);
    expect(formatEffectWithCi({ value: 5, unit: 'mV', ciLow: null, ciHigh: null })).toEqual({ value: '+5 mV', ci: null, digits: 1 });
  });
});
