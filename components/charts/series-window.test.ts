import { describe, expect, it } from 'vitest';
import type { SeriesPayload } from '@/lib/data/series-types';
import { assignAxes, fitsAxes, isFullZoom, keepWithinAxes, mergeWindow, zoomWindow } from './series-window';

describe('assignAxes', () => {
  it('처음 나온 단위 순서로 왼쪽·오른쪽 축을 배정한다', () => {
    expect(assignAxes(['kW', 'kW', '°C', 'kW'])).toEqual({ axisUnits: ['kW', '°C'], axisIndexes: [0, 0, 1, 0] });
  });

  it('세 번째 단위부터는 축을 주지 않는다', () => {
    expect(assignAxes(['kW', '%', 'V', '%'])).toEqual({ axisUnits: ['kW', '%'], axisIndexes: [0, 1, null, 1] });
  });

  it('무차원(빈 단위)도 하나의 단위로 본다', () => {
    expect(assignAxes(['', 'kW'])).toEqual({ axisUnits: ['', 'kW'], axisIndexes: [0, 1] });
  });
});

describe('fitsAxes', () => {
  it('이미 있는 단위이거나 축이 하나 남았을 때만 허용한다', () => {
    expect(fitsAxes([], 'kW')).toBe(true);
    expect(fitsAxes(['kW'], '°C')).toBe(true);
    expect(fitsAxes(['kW', '°C'], 'kW')).toBe(true);
    expect(fitsAxes(['kW', '°C', 'kW'], 'V')).toBe(false);
  });
});

describe('keepWithinAxes', () => {
  it('세 번째 단위가 되는 항목은 빼고 순서를 유지한다', () => {
    const items = [
      { id: 1, unit: 'V' },
      { id: 2, unit: 'A' },
      { id: 3, unit: '°C' },
      { id: 4, unit: 'V' },
    ];
    expect(keepWithinAxes(items).map((item) => item.id)).toEqual([1, 2, 4]);
  });
});

describe('zoomWindow', () => {
  it('% 범위를 시각 구간으로 바꾼다', () => {
    expect(zoomWindow(0, 1_000, 25, 50)).toEqual({ fromMs: 250, toMs: 500 });
  });

  it('범위를 벗어난 값은 자르고 뒤집힌 순서도 받는다', () => {
    expect(zoomWindow(1_000, 2_000, 120, -5)).toEqual({ fromMs: 1_000, toMs: 2_000 });
  });

  it('길이가 0이 되지 않게 한다', () => {
    expect(zoomWindow(0, 1_000, 40, 40)).toEqual({ fromMs: 400, toMs: 401 });
  });
});

describe('isFullZoom', () => {
  it('0.5% 여유 안이면 전체로 본다', () => {
    expect(isFullZoom(0, 100)).toBe(true);
    expect(isFullZoom(0.4, 99.6)).toBe(true);
    expect(isFullZoom(1, 100)).toBe(false);
  });
});

describe('mergeWindow', () => {
  const base: SeriesPayload = {
    source: '1h',
    bucketSeconds: 7_200,
    fromMs: 0,
    toMs: 100,
    series: [
      { pointId: 1, rows: [[0, 1, 2, 3], [40, 1, 2, 3], [60, 1, 2, 3], [90, 1, 2, 3]] },
      { pointId: 2, rows: [[0, 5, 5, 5]] },
    ],
  };
  const detail: SeriesPayload = {
    source: 'raw',
    bucketSeconds: 60,
    fromMs: 40,
    toMs: 70,
    series: [{ pointId: 1, rows: [[45, 0, 0, 0], [50, 9, 9, 9]] }],
  };

  it('확대 구간 안의 거친 버킷을 세밀한 버킷으로 바꾸고 시간 순으로 정렬한다', () => {
    const merged = mergeWindow(base, detail);
    expect(merged.series[0].rows).toEqual([[0, 1, 2, 3], [45, 0, 0, 0], [50, 9, 9, 9], [90, 1, 2, 3]]);
  });

  it('세밀한 첫 버킷이 확대 시작보다 앞서면 그 사이의 거친 버킷도 뺀다', () => {
    const early: SeriesPayload = { ...detail, series: [{ pointId: 1, rows: [[38, 7, 7, 7], [50, 9, 9, 9]] }] };
    const coarse: SeriesPayload = { ...base, series: [{ pointId: 1, rows: [[0, 1, 2, 3], [39, 1, 2, 3], [90, 1, 2, 3]] }] };
    expect(mergeWindow(coarse, early).series[0].rows).toEqual([[0, 1, 2, 3], [38, 7, 7, 7], [50, 9, 9, 9], [90, 1, 2, 3]]);
  });

  it('세밀한 데이터가 없는 포인트와 전체 구간 정보는 그대로 둔다', () => {
    const merged = mergeWindow(base, detail);
    expect(merged.series[1]).toBe(base.series[1]);
    expect(merged).toMatchObject({ source: '1h', bucketSeconds: 7_200, fromMs: 0, toMs: 100 });
  });

  it('입력을 바꾸지 않는다', () => {
    const before = JSON.stringify(base);
    mergeWindow(base, detail);
    expect(JSON.stringify(base)).toBe(before);
  });
});
