import { describe, expect, it } from 'vitest';
import { overlayXY, summarizeCurve, type CurvePoint } from './overlay';

const curve: readonly CurvePoint[] = [
  { elapsedS: 0, ah: 0, soc: 10 },
  { elapsedS: 1_800, ah: 25, soc: 15 },
  { elapsedS: 3_600, ah: 50, soc: null },
  { elapsedS: 7_200, ah: 100, soc: 30 },
];

describe('overlayXY', () => {
  it('경과시간 축: x = 경과 시간(h), y = SOC. SOC가 없는 점은 뺀다', () => {
    expect(overlayXY(curve, 'elapsed')).toEqual([
      [0, 10],
      [0.5, 15],
      [2, 30],
    ]);
  });

  it('누적 Ah 축: x = 누적 Ah, y = SOC', () => {
    expect(overlayXY(curve, 'ah')).toEqual([
      [0, 10],
      [25, 15],
      [100, 30],
    ]);
  });

  it('SOC 축: x = SOC, y = 누적 Ah (기울기가 유효용량 Ah/%)', () => {
    const xy = overlayXY(curve, 'soc');
    expect(xy).toEqual([
      [10, 0],
      [15, 25],
      [30, 100],
    ]);
    const [x0, y0] = xy[0] as readonly [number, number];
    const [x1, y1] = xy[2] as readonly [number, number];
    expect(((y1 - y0) / (x1 - x0)) * 100).toBe(500); // 100 Ah / 20%p → 500 Ah
  });

  it('첫 점이 0이 아니어도 t=0·0 Ah 기준으로 다시 맞춘다 (기준·최근 곡선 정렬)', () => {
    const shifted = curve.map((p) => ({ ...p, elapsedS: p.elapsedS + 600, ah: p.ah + 3 }));
    expect(overlayXY(shifted, 'elapsed')).toEqual(overlayXY(curve, 'elapsed'));
    expect(overlayXY(shifted, 'soc')).toEqual(overlayXY(curve, 'soc'));
  });

  it('빈 곡선은 빈 배열', () => {
    expect(overlayXY([], 'ah')).toEqual([]);
  });
});

describe('summarizeCurve', () => {
  it('충전 시간·누적 Ah·시작·끝 SOC', () => {
    expect(summarizeCurve(curve)).toEqual({ durationH: 2, ahTotal: 100, socStart: 10, socEnd: 30 });
    expect(summarizeCurve([])).toBeNull();
  });
});
