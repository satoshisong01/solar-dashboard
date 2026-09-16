// 체인 원장 기간 합 → Sankey 노드·링크 (순수). ECharts sankey가 받는 모양(노드 이름 = 고유 id, 링크 source·target = 노드 id).
//   에너지 [kWh]  일별 flows_kwh(pool_hourly@1 할당)를 (공급, 수요)별로 더한다. 공급·수요 양쪽에 있는 '미계측'은 id를 나눠 둔다.
//   수소 [kg]     수소 원장 네 값이 모두 있는 날의 합: 생산 P · 연료전지 소비 C · 저장 변화 S(순) · 배기 추정 V(없으면 0).
//                 잔차 R = P − C − S − V (일별 반올림 잔차 합과 0.001 kg 수준만 다르다). 음수 쪽은 반대편 노드로 옮겨 모두 0 이상으로 만든다:
//                 공급 {생산 P, 저장 인출 max(−S,0), 잔차 유입 max(−R,0)} = 수요 {연료전지 C, 저장 증가 max(S,0), 배기 V, 잔차 손실 max(R,0)}
//                 두 합은 항등식으로 같고, 흐름은 에너지와 같은 비례 할당(공급 × 수요 ÷ 합계)으로 나눈다 (공급원별 실제 경로가 아니다).
//   0 흐름(0.001 반올림 뒤 0 이하)과 링크가 없는 노드는 뺀다.
import { DEMAND_NODES, SUPPLY_NODES, UNMETERED, type DemandNode, type SiteEnergyDay, type SupplyNode } from '@/lib/analytics/ledger/types';
import { DEMAND_LABELS, HYDROGEN_NODE_LABELS, SUPPLY_LABELS } from './labels';

export interface SankeyNode {
  readonly id: string;
  readonly label: string;
  /** 왼쪽(공급) · 오른쪽(수요) */
  readonly side: 'supply' | 'demand';
  readonly value: number;
  /** 계측 불일치·설명 안 된 잔차 노드 (회색·점선 느낌으로 구분) */
  readonly unmetered: boolean;
}

export interface SankeyLink {
  readonly source: string;
  readonly target: string;
  readonly value: number;
  readonly unmetered: boolean;
}

export interface SankeyData {
  readonly nodes: readonly SankeyNode[];
  readonly links: readonly SankeyLink[];
  readonly total: number;
  /** 합계에 들어간 날 수 */
  readonly days: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const supplyId = (node: SupplyNode): string => `supply:${node}`;
const demandId = (node: DemandNode): string => `demand:${node}`;

interface Endpoint {
  readonly id: string;
  readonly label: string;
  readonly unmetered: boolean;
}

/** 링크 목록에서 노드를 만든다 (공급 → 수요 순서는 endpoints 순서, 링크가 없는 노드는 뺀다) */
function assemble(endpoints: readonly (Endpoint & { readonly side: SankeyNode['side'] })[], rawLinks: readonly SankeyLink[], days: number): SankeyData {
  const links = rawLinks.map((l) => ({ ...l, value: round3(l.value) })).filter((l) => l.value > 0);
  const valueOf = (id: string, side: SankeyNode['side']) => links.filter((l) => (side === 'supply' ? l.source : l.target) === id).reduce((sum, l) => sum + l.value, 0);
  const nodes = endpoints.map((e) => ({ ...e, value: round3(valueOf(e.id, e.side)) })).filter((n) => n.value > 0);
  return { nodes, links, total: round3(links.reduce((sum, l) => sum + l.value, 0)), days };
}

export function energySankey(days: readonly SiteEnergyDay[]): SankeyData {
  const sums = new Map<string, number>();
  for (const day of days) {
    for (const flow of day.flows_kwh) {
      const key = `${flow.from}>${flow.to}`;
      sums.set(key, (sums.get(key) ?? 0) + flow.kwh);
    }
  }
  const supplies: readonly SupplyNode[] = [...SUPPLY_NODES, UNMETERED];
  const demands: readonly DemandNode[] = [...DEMAND_NODES, UNMETERED];
  const links = supplies.flatMap((from) =>
    demands.map((to) => ({ source: supplyId(from), target: demandId(to), value: sums.get(`${from}>${to}`) ?? 0, unmetered: from === UNMETERED || to === UNMETERED })),
  );
  const endpoints = [
    ...supplies.map((node) => ({ id: supplyId(node), label: SUPPLY_LABELS[node], side: 'supply' as const, unmetered: node === UNMETERED })),
    ...demands.map((node) => ({ id: demandId(node), label: DEMAND_LABELS[node], side: 'demand' as const, unmetered: node === UNMETERED })),
  ];
  return assemble(endpoints, links, days.filter((d) => d.flows_kwh.length > 0).length);
}

type HydrogenKey = keyof typeof HYDROGEN_NODE_LABELS;

export function hydrogenSankey(days: readonly SiteEnergyDay[]): SankeyData {
  const used = days.filter((d) => d.h2_kg.produced !== null && d.h2_kg.fc_consumed !== null && d.h2_kg.stored_delta !== null && d.h2_kg.residual !== null);
  const sum = (pick: (d: SiteEnergyDay) => number | null) => used.reduce((acc, d) => acc + (pick(d) ?? 0), 0);
  const produced = sum((d) => d.h2_kg.produced);
  const delivered = sum((d) => d.h2_kg.delivered);
  const consumed = sum((d) => d.h2_kg.fc_consumed);
  const stored = sum((d) => d.h2_kg.stored_delta);
  const vented = sum((d) => d.h2_kg.vented_est);
  const residual = produced + delivered - consumed - stored - vented;
  // 반입이 없는 사이트(합계 0)는 노드를 만들지 않는다 — 기존 사이트 그림이 그대로다
  const sources: readonly (readonly [HydrogenKey, number, boolean])[] = [
    ['produced', produced, false],
    ...(delivered > 0 ? ([['delivered', delivered, false]] as const) : []),
    ['storageOut', Math.max(0, -stored), false],
    ['residualIn', Math.max(0, -residual), true],
  ];
  const sinks: readonly (readonly [HydrogenKey, number, boolean])[] = [
    ['fcConsumed', consumed, false],
    ['storageIn', Math.max(0, stored), false],
    ['vented', vented, false],
    ['residualOut', Math.max(0, residual), true],
  ];
  const total = sources.reduce((acc, [, v]) => acc + v, 0);
  const links = total > 0 ? sources.flatMap(([from, s, su]) => sinks.map(([to, d, du]) => ({ source: `h2:${from}`, target: `h2:${to}`, value: (s * d) / total, unmetered: su || du }))) : [];
  const endpoints = [
    ...sources.map(([key, , unmetered]) => ({ id: `h2:${key}`, label: HYDROGEN_NODE_LABELS[key], side: 'supply' as const, unmetered })),
    ...sinks.map(([key, , unmetered]) => ({ id: `h2:${key}`, label: HYDROGEN_NODE_LABELS[key], side: 'demand' as const, unmetered })),
  ];
  return assemble(endpoints, links, used.length);
}
