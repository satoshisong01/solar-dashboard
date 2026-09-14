import { describe, expect, it } from 'vitest';
import { cusum, ewma, standardize } from './change';

describe('cusum', () => {
  it('상향 계단 변화: 경보 인덱스와 변화 시작 인덱스를 손 계산과 맞춘다', () => {
    const residuals = [0, 0.2, -0.1, 0, 2, 2, 2, 2];
    // S⁺: 0, 0, 0, 0, 1.5, 3.0, 4.5, 6.0 → 인덱스 7에서 h=5 초과, 시작은 4
    const result = cusum(residuals, { k: 0.5, h: 5 });
    expect(result).toMatchObject({ alarmIndex: 7, changeStartIndex: 4, direction: 'up' });
    expect(result.maxUpper).toBeCloseTo(6, 12);
  });

  it('하향 변화는 direction down, 방향을 up으로 제한하면 경보 없음', () => {
    const residuals = [0, 0, -1.5, -1.5, -1.5, -1.5, -1.5, -1.5];
    // S⁻: 0, 0, 1, 2, 3, 4, 5, 6 → h=5 초과는 인덱스 7
    expect(cusum(residuals)).toMatchObject({ alarmIndex: 7, changeStartIndex: 2, direction: 'down' });
    expect(cusum(residuals, { direction: 'up' })).toMatchObject({ alarmIndex: null, changeStartIndex: null, direction: null });
  });

  it('성질: k 이하 잡음만 있으면 경보가 없다', () => {
    const residuals = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.4 : -0.4));
    expect(cusum(residuals, { h: 4 }).alarmIndex).toBeNull();
  });
});

describe('standardize', () => {
  it('기준 구간 중앙값·1.4826·MAD로 나눈다', () => {
    const z = standardize([10, 12], [9, 10, 11]);
    expect(z[0]).toBe(0);
    expect(z[1]).toBeCloseTo(2 / 1.4826, 10);
  });

  it('σ가 0이면 하한을 쓰고, 하한도 없으면 오류', () => {
    expect(standardize([6], [5, 5, 5], 0.5)).toEqual([2]);
    expect(() => standardize([6], [5, 5, 5])).toThrow(RangeError);
  });
});

describe('ewma', () => {
  it('λ=0.5 손 계산', () => {
    expect(ewma([0, 4, 4], 0.5, 0)).toEqual([0, 2, 3]);
    expect(ewma([2, 4], 0.5)).toEqual([2, 3]);
  });

  it('λ=1이면 원래 값, 빈 배열은 빈 배열, 범위 밖 λ는 오류', () => {
    expect(ewma([1, 5, 2], 1)).toEqual([1, 5, 2]);
    expect(ewma([], 0.2)).toEqual([]);
    expect(() => ewma([1], 0)).toThrow(RangeError);
  });
});
