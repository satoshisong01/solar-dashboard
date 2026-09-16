// 공정도 흐름선 종류. 도면 FCND-GP-PID-002 REV.2의 LINE LEGEND를 그대로 옮긴 것이다.
// 순수 모듈 (서버·클라이언트 공용, 'server-only' 금지).
//
// 색은 app/globals.css의 --flow-* 토큰이고, 흐름선은 **물질만** 나타낸다.
// 상태(발견사항)는 설비 상자 테두리·배지로만 나타낸다 — 흐름색과 경보색이 겹쳐 보이지 않게 하기 위해서다
// (docs/renewal/pid-gapyeong-plan.md §7.4).

export type FlowKind = 'water.feed' | 'water.recycle' | 'h2' | 'o2' | 'dc' | 'ac' | 'heat.supply' | 'heat.return';

export interface FlowStyle {
  /** 도면 범례 문구 */
  readonly label: string;
  /** CSS 변수 이름 (app/globals.css) */
  readonly token: string;
  readonly width: number;
  /** stroke-dasharray. 실선이면 null */
  readonly dash: string | null;
}

/** 도면 범례 순서 그대로 */
export const FLOW_KINDS: readonly FlowKind[] = ['water.feed', 'water.recycle', 'h2', 'o2', 'dc', 'ac', 'heat.supply', 'heat.return'];

export const FLOW_STYLES: Readonly<Record<FlowKind, FlowStyle>> = {
  'water.feed': { label: '정제수 급수', token: '--flow-water', width: 2.2, dash: null },
  'water.recycle': { label: '회수수 재순환', token: '--flow-recycle', width: 2.2, dash: '8 4' },
  h2: { label: '수소 H₂', token: '--flow-h2', width: 3, dash: null },
  o2: { label: '산소 O₂', token: '--flow-o2', width: 2.2, dash: null },
  dc: { label: 'DC 전력', token: '--flow-dc', width: 2.6, dash: null },
  // 도면 범례는 AC를 적색(#d1341f)으로 쓰지만 콘솔의 경보색(--crit)과 구분되지 않는다. 색만 보라로 바꿨다.
  ac: { label: 'AC 전력', token: '--flow-ac', width: 2.6, dash: null },
  'heat.supply': { label: '폐열 온수 75 °C', token: '--flow-heat', width: 2.6, dash: null },
  // 도면이 환수를 점선으로 그린다
  'heat.return': { label: '환수 60 °C', token: '--flow-heat', width: 2.2, dash: '6 4' },
};
