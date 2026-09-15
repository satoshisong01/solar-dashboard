import { describe, expect, it } from 'vitest';
import { lineValueAt, trendAxisText, trendBand } from './trend';

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

describe('trendAxisText', () => {
  it('x축 종류별 이름·점 설명·표기', () => {
    expect(trendAxisText('time').value(Date.UTC(2026, 8, 14, 15))).toBe('2026-09-15');
    expect(trendAxisText('op_hours')).toMatchObject({ name: '누적 운전시간 (h)', pointLabel: '운전시간 구간 중앙값' });
    expect(trendAxisText('op_hours').value(1340.7)).toBe('누적 1,341 h');
    expect(trendAxisText('elapsed_days').tick(97)).toBe('97');
    expect(trendAxisText('elapsed_days').value(97)).toBe('97일째');
  });
});
