// 에피소드 오버레이 데이터 변환 (설계 §4.1): 기준·최근 대표 충전 곡선을 t=0 정렬로 겹치고 x축을 바꾼다. 순수 모듈.
//   경과시간 축: x = 경과 [h], y = SOC [%]
//   누적 Ah 축: x = 누적 충전 [Ah], y = SOC [%]
//   SOC 축:     x = SOC [%], y = 누적 충전 [Ah]  (기울기 ΔAh/ΔSOC가 유효용량)

export type OverlayAxis = 'elapsed' | 'ah' | 'soc';

export const OVERLAY_AXES: readonly OverlayAxis[] = ['elapsed', 'ah', 'soc'];

export interface OverlayAxisMeta {
  readonly label: string;
  readonly xName: string;
  readonly yName: string;
}

export const OVERLAY_AXIS_META: Readonly<Record<OverlayAxis, OverlayAxisMeta>> = {
  elapsed: { label: '경과시간', xName: '경과 (h)', yName: 'SOC (%)' },
  ah: { label: '누적 Ah', xName: '누적 충전 (Ah)', yName: 'SOC (%)' },
  soc: { label: 'SOC', xName: 'SOC (%)', yName: '누적 충전 (Ah)' },
};

export interface CurvePoint {
  /** 세션 시작부터 [s] */
  readonly elapsedS: number;
  /** 세션 시작부터 누적 충전 [Ah] */
  readonly ah: number;
  readonly soc: number | null;
}

export interface ChargeCurve {
  /** 세션 시작 epoch ms */
  readonly start: number;
  /** 이 세션의 용량 추정값 [Ah] */
  readonly capacityAh: number | null;
  readonly points: readonly CurvePoint[];
}

export type XY = readonly [x: number, y: number];

const SECONDS_PER_HOUR = 3_600;

/** 곡선 → [x, y] 목록 (시간 순서 유지). SOC가 없는 점은 뺀다. 첫 점 경과·Ah가 0이 아니어도 t=0 기준으로 다시 맞춘다 */
export function overlayXY(points: readonly CurvePoint[], axis: OverlayAxis): XY[] {
  const first = points[0];
  if (!first) return [];
  return points.flatMap((p): XY[] => {
    if (p.soc === null || !Number.isFinite(p.soc)) return [];
    const elapsedH = (p.elapsedS - first.elapsedS) / SECONDS_PER_HOUR;
    const ah = p.ah - first.ah;
    switch (axis) {
      case 'elapsed':
        return [[elapsedH, p.soc]];
      case 'ah':
        return [[ah, p.soc]];
      case 'soc':
        return [[p.soc, ah]];
    }
  });
}

export interface CurveSummary {
  readonly durationH: number;
  readonly ahTotal: number;
  readonly socStart: number | null;
  readonly socEnd: number | null;
}

/** 범례·표용 요약: 충전 시간·누적 Ah·시작·끝 SOC */
export function summarizeCurve(points: readonly CurvePoint[]): CurveSummary | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const socs = points.flatMap((p) => (p.soc === null ? [] : [p.soc]));
  return {
    durationH: (last.elapsedS - first.elapsedS) / SECONDS_PER_HOUR,
    ahTotal: last.ah - first.ah,
    socStart: socs[0] ?? null,
    socEnd: socs[socs.length - 1] ?? null,
  };
}
