import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { hampelFilter, mad, mean, median, modifiedZ, quantile, weightedMedian } from './robust';

describe('weightedMedian', () => {
  it('가중치가 같으면 median과 같고(짝수 길이 평균 포함), 큰 가중치 쪽으로 옮겨 간다', () => {
    const rng = createRng(9);
    for (const n of [1, 2, 5, 8]) {
      const values = Array.from({ length: n }, () => rng.gaussian());
      expect(weightedMedian(values, values.map(() => 3))).toBeCloseTo(median(values), 12);
    }
    expect(weightedMedian([1, 2, 3], [1, 1, 5])).toBe(3);
    expect(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1])).toBe(2.5);
    expect(weightedMedian([10, 20], [0, 1])).toBe(20);
  });

  it('길이가 다르거나 가중치가 음수·합 0이면 오류', () => {
    expect(() => weightedMedian([1], [1, 2])).toThrow(RangeError);
    expect(() => weightedMedian([1, 2], [-1, 2])).toThrow(RangeError);
    expect(() => weightedMedian([1, 2], [0, 0])).toThrow(RangeError);
    expect(() => weightedMedian([], [])).toThrow(RangeError);
  });
});

describe('median / quantile / mean', () => {
  it('홀수·짝수 길이 중앙값과 입력 불변', () => {
    const values = [5, 1, 3];
    expect(median(values)).toBe(3);
    expect(values).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('선형 보간 분위수 (numpy 기본값과 같다)', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(10);
    expect(quantile(values, 0.25)).toBeCloseTo(3.25, 12);
    expect(quantile(values, 0.9)).toBeCloseTo(9.1, 12);
  });

  it('빈 배열·범위 밖 p는 오류', () => {
    expect(() => median([])).toThrow(RangeError);
    expect(() => mean([])).toThrow(RangeError);
    expect(() => quantile([1], 1.5)).toThrow(RangeError);
  });

  it('성질: 분위수는 p에 대해 단조 증가하고 min~max 안에 있다', () => {
    const rng = createRng(3);
    const values = Array.from({ length: 57 }, () => rng.gaussian() * 10);
    const ps = [0, 0.1, 0.33, 0.5, 0.77, 0.95, 1];
    const qs = ps.map((p) => quantile(values, p));
    qs.slice(1).forEach((q, i) => expect(q).toBeGreaterThanOrEqual(qs[i] as number));
    expect(qs[0]).toBe(Math.min(...values));
    expect(qs[qs.length - 1]).toBe(Math.max(...values));
  });
});

describe('mad / modifiedZ', () => {
  it('알려진 값: [1,2,3,4,100] → median 3, MAD 1', () => {
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    const z = modifiedZ([1, 2, 3, 4, 100]);
    expect(z[2]).toBe(0);
    expect(z[4]).toBeCloseTo(0.6745 * 97, 10);
    expect(z[0]).toBeCloseTo(-1.349, 10);
  });

  it('MAD 하한을 쓰면 z가 작아진다', () => {
    const values = [10, 10, 10, 10, 9.9];
    const floored = modifiedZ(values, { madFloor: 0.05 });
    expect(floored[4]).toBeCloseTo((0.6745 * -0.1) / 0.05, 10);
  });

  it('MAD가 0이면 평균절대편차로 대신하고, 모두 같으면 0', () => {
    const z = modifiedZ([5, 5, 5, 5, 6]);
    expect(z[4]).toBeCloseTo(1 / (1.253314 * 0.2), 6);
    expect(modifiedZ([2, 2, 2])).toEqual([0, 0, 0]);
  });

  it('성질: 척도·위치 변환에 불변', () => {
    const rng = createRng(9);
    const values = Array.from({ length: 30 }, () => rng.gaussian());
    const shifted = modifiedZ(values.map((v) => 3 * v + 7));
    modifiedZ(values).forEach((z, i) => expect(shifted[i]).toBeCloseTo(z, 9));
  });
});

describe('hampelFilter', () => {
  it('단독 스파이크를 창 중앙값으로 바꾸고 인덱스를 알려 준다', () => {
    const values = [1, 1.1, 0.9, 1, 50, 1, 1.05, 0.95, 1];
    const result = hampelFilter(values, { halfWindow: 3, nSigmas: 3 });
    expect(result.outlierIndices).toEqual([4]);
    expect(result.values[4]).toBeCloseTo(1, 6);
    expect(values[4]).toBe(50);
  });

  it('완만한 추세는 건드리지 않는다', () => {
    const values = Array.from({ length: 20 }, (_, i) => i * 0.5);
    expect(hampelFilter(values).outlierIndices).toEqual([]);
  });
});
