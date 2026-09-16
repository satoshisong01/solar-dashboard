import { describe, expect, it } from 'vitest';
import { hiddenLabels, type LabelPoint } from './label-overlap';

const SIZE = { width: 160, height: 44, offsetY: 18, markerRadius: 20 };
const at = (code: string, x: number, y: number): LabelPoint => ({ code, x, y });

describe('hiddenLabels', () => {
  it('멀리 떨어진 발전소는 모두 라벨을 보인다', () => {
    expect(hiddenLabels([at('A', 100, 100), at('B', 400, 100), at('C', 100, 400)], SIZE)).toEqual(new Set());
  });

  it('겹치면 앞에 온 것(급한 것)이 남고 뒤가 접힌다', () => {
    expect(hiddenLabels([at('A', 100, 100), at('B', 140, 110)], SIZE)).toEqual(new Set(['B']));
    expect(hiddenLabels([at('B', 140, 110), at('A', 100, 100)], SIZE)).toEqual(new Set(['A']));
  });

  it('선택한 발전소는 순서와 상관없이 언제나 남는다', () => {
    expect(hiddenLabels([at('A', 100, 100), at('B', 140, 110)], SIZE, new Set(['B']))).toEqual(new Set(['A']));
  });

  it('경계값: 상자가 스치기만 하면 겹친 것으로 보지 않는다', () => {
    expect(hiddenLabels([at('A', 0, 0), at('B', SIZE.width, 0)], SIZE)).toEqual(new Set());
    expect(hiddenLabels([at('A', 0, 0), at('B', SIZE.width - 1, 0)], SIZE)).toEqual(new Set(['B']));
  });

  it('라벨이 옆 발전소의 마커 원 위에 얹히는 것도 겹침으로 본다', () => {
    // B의 원(중심 y)이 A의 라벨 카드 범위(offsetY ~ offsetY + height) 안에 들어온다
    expect(hiddenLabels([at('A', 100, 0), at('B', 100, SIZE.offsetY + 10)], SIZE)).toEqual(new Set(['B']));
  });

  it('세 번째가 남은 자리에 들어가면 접지 않는다 (먼저 접힌 것의 자리를 차지하지 않는다)', () => {
    const hidden = hiddenLabels([at('A', 100, 100), at('B', 120, 100), at('C', 400, 100)], SIZE);
    expect(hidden).toEqual(new Set(['B']));
  });

  it('좌표를 모르면(지도가 아직 안 그려짐) 아무것도 접지 않는다', () => {
    expect(hiddenLabels([at('A', Number.NaN, Number.NaN), at('B', Number.NaN, Number.NaN)], SIZE)).toEqual(new Set());
  });
});
