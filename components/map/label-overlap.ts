// 지도 마커 라벨 겹침 처리. 순수 함수 (좌표는 부르는 쪽이 지도 투영으로 구한다).
// 확대 수준이 낮아 가까운 발전소들의 라벨 카드가 서로 겹치면, 급한 것부터 자리를 잡고 겹치는 라벨은 접는다
// (마커 원과 상태색은 그대로 남아 어디에 무엇이 있는지는 계속 보인다).

export interface LabelPoint {
  readonly code: string;
  /** 지도 컨테이너 왼쪽 위 기준 픽셀 좌표 (마커 원의 중심) */
  readonly x: number;
  readonly y: number;
}

export interface LabelSize {
  readonly width: number;
  readonly height: number;
  /** 마커 원 아래에서 라벨 카드 위쪽까지의 거리 */
  readonly offsetY: number;
  /** 마커 원(+건수 배지)의 반지름. 라벨이 옆 발전소의 원 위에 겹치는 것도 막는다 */
  readonly markerRadius: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** 마커가 차지하는 자리: 원(위)과 그 아래 가운데에 붙는 라벨 카드를 함께 본다 */
function boxOf(point: LabelPoint, size: LabelSize): Box {
  return {
    left: point.x - size.width / 2,
    right: point.x + size.width / 2,
    top: point.y - size.markerRadius,
    bottom: point.y + size.offsetY + size.height,
  };
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * 라벨을 접을 발전소 코드. points는 급한 순으로 주고, pinned(선택·마우스 올린 것)는 언제나 먼저 자리를 잡는다.
 * 좌표를 알 수 없는 것(NaN)은 접지 않는다: 지도가 아직 안 그려진 사이에 라벨이 사라지지 않게.
 */
export function hiddenLabels(points: readonly LabelPoint[], size: LabelSize, pinned: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const ordered = [...points.filter((point) => pinned.has(point.code)), ...points.filter((point) => !pinned.has(point.code))];
  const placed: Box[] = [];
  const hidden = new Set<string>();
  for (const point of ordered) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const box = boxOf(point, size);
    if (!pinned.has(point.code) && placed.some((other) => overlaps(other, box))) {
      hidden.add(point.code);
      continue;
    }
    placed.push(box);
  }
  return hidden;
}
