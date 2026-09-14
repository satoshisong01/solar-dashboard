import { describe, expect, it } from 'vitest';
import { lineValueAt, trendBand } from './trend';

describe('lineValueAt', () => {
  it('두 끝점 선을 보간·연장한다', () => {
    const line = [
      [0, 10],
      [10, 30],
    ] as const;
    expect(lineValueAt(line, 5)).toBe(20);
    expect(lineValueAt(line, 20)).toBe(50);
    expect(lineValueAt([[0, 1]], 3)).toBeNull();
  });
});

describe('trendBand', () => {
  const points = [
    [0, 10],
    [2, 14],
    [4, 18],
    [6, 22],
    [10, 30],
  ] as const;
  const line = [
    [0, 10],
    [10, 30],
  ] as const;

  it('점들의 x 중앙값(4)에서 폭 0, 양 끝에서 기울기 CI만큼 벌어진다', () => {
    const band = trendBand({ points, line, slope: 2, ciLow: 1.5, ciHigh: 2.5 });
    expect(band).toEqual({
      lower: [
        [0, 8],
        [4, 18],
        [10, 27],
      ],
      upper: [
        [0, 12],
        [4, 18],
        [10, 33],
      ],
    });
  });

  it('선이나 CI가 없으면 null', () => {
    expect(trendBand({ points, line: null, slope: 2, ciLow: 1.5, ciHigh: 2.5 })).toBeNull();
    expect(trendBand({ points, line, slope: 2, ciLow: null, ciHigh: 2.5 })).toBeNull();
    expect(trendBand({ points: [], line, slope: 2, ciLow: 1.5, ciHigh: 2.5 })).toBeNull();
  });
});
