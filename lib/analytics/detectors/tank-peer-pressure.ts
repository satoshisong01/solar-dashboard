// tank.static_leak 압력 교차 확인 입력 (순수): 정지 보유 구간마다 같은 뱅크 다른 용기(없으면 압축기 토출) 압력의 기울기.
// 정지 보유 중에는 용기별 차단밸브가 닫혀 용기마다 따로 줄어들기 때문에,
//   · 대상 용기만 떨어지면  → 그 용기에만 있는 손실(누설)
//   · 뱅크 전체가 함께 떨어지면 → 공용 소비(정지 판정이 놓친 인출)나 압력 기준 이동
// 을 구분할 수 있다. 판정은 탐지기(tank-static-leak-checks.ts peerCheck)가 대상 용기의 같은 구간 압력 기울기와 비교해서 한다
// (온도 보정을 하지 않은 원 압력 기울기끼리 빼면 같은 뱅크가 함께 겪는 야간 냉각이 상쇄된다).
import { pointsIn, type TimedValue } from '../episodes/series';
import { median } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { MS_PER_DAY, type TimeWindow } from '../types';

export type PressureCrossSource = 'peer_tank' | 'compressor_discharge';

/** 정지 보유 구간 하나의 비교 대상 압력 기울기 */
export interface PressureCrossCheck {
  /** 대상 구간 시작 (tank.hold 에피소드 start와 같아야 짝이 맞는다) */
  readonly holdStart: number;
  /** 구간 안 비교 대상 압력의 기울기 중앙값 [bar/일] (음수 = 비교 대상도 함께 떨어짐) */
  readonly slopeBarPerDay: number;
  readonly source: PressureCrossSource;
  /** 기울기를 잰 비교 대상 수 */
  readonly n: number;
}

/** 기울기를 재는 데 필요한 최소 점 수 (탐지기 구간 판정과 같은 보수적 기준) */
const MIN_POINTS = 5;

function slopeBarPerDay(points: readonly TimedValue[], hold: TimeWindow): number | null {
  const inside = pointsIn(points, hold);
  if (inside.length < MIN_POINTS) return null;
  const xs = inside.map((pt) => (pt.ts - hold.start) / MS_PER_DAY);
  if (new Set(xs).size < 3) return null;
  return theilSen(xs, inside.map((pt) => pt.value)).slope;
}

/**
 * 비교 대상 압력 시계열들(대상 용기 자신은 빼고 넣는다) → 구간별 기울기 중앙값.
 * 어떤 구간에서도 기울기를 재지 못하면 그 구간은 결과에 넣지 않는다 (탐지기가 '데이터없음'으로 본다).
 */
export function pressureCrossChecks(series: readonly (readonly TimedValue[])[], source: PressureCrossSource, holds: readonly TimeWindow[]): PressureCrossCheck[] {
  if (series.length === 0) return [];
  return holds.flatMap((hold) => {
    const slopes = series.flatMap((points) => slopeBarPerDay(points, hold) ?? []);
    return slopes.length === 0 ? [] : [{ holdStart: hold.start, slopeBarPerDay: median(slopes), source, n: slopes.length }];
  });
}
