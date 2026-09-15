// 에너지 흐름 할당 pool_hourly@1 (순수).
//
// 규칙
//   1) 매시 공급원 {pv, ess_discharge, fc, grid_import}을 한 풀로 모은다.
//      pv = 인버터 ac.power 양수 합, ess = PCS ac.power(방전 +, 충전 −), fc = fc.ac.power 양수 합, 계통 = 계량기 ac.power(송전 +, 수전 −).
//   2) 수요처 {site_aux, ess_charge, electrolyzer, compressor, grid_export}.
//      electrolyzer = 정류기 AC 입력(없으면 전해조 설비 전체 AC). 전해조 BoP(설비 전체 − 정류기), 인버터 야간 소비, 연료전지 대기 소비는 site_aux 계측분이다.
//   3) 계측 불일치 = 공급 합 − 계측 수요 합.
//      params.siteAuxKw가 null(보조부하 계량 없음)이면 양의 불일치를 보조부하로 보고(aux_basis=residual),
//      추정값이 있으면 양의 불일치를 unmetered 수요로 둔다(aux_basis=estimate). 음의 불일치(계측 수요 > 공급)는 항상 unmetered 공급이다.
//   4) 두 합을 맞춘 뒤 흐름 from→to = 공급 × 수요 / 풀 합계 로 비례 할당하고 하루 동안 더한다.
//      전력 원천 행이 하나도 없는 시간은 풀에서 뺀다(dq.energy.completeness가 빈 시간을 드러낸다).
//
// 한계 (결과를 해석할 때 반드시 함께 보여 줄 것)
//   - 비례 할당은 "한 시간 안의 전력은 섞인다"는 회계 가정이다. 실제 전기적 경로(예: PV가 전해조에 직접 연결)가 아니다.
//   - m_1h 시간 평균을 쓰므로 한 시간 안에서 충전과 방전, 수전과 송전이 번갈아 일어나면 순값만 남는다(둘 다 작게 잡힌다).
//   - ESS 방전은 PV로 충전한 전력이라고 가정한다(renewable_share). 계통 충전분 추적은 하지 않는다.
//   - 청정수소 인증 공식 산정(월 매칭·전력배출계수)이 아니다.
import { assetsOf, dayCompleteness, hasDayData, round, signedEnergy, type LedgerContext } from './hourly';
import type { LedgerParams } from './params';
import { DEMAND_NODES, SUPPLY_NODES, UNMETERED, type AuxBasis, type DemandNode, type ElzPowerBasis, type EnergyFlow, type EnergyTotals, type SiteEnergyDq, type SupplyNode } from './types';

const SUPPLY_ORDER: readonly SupplyNode[] = [...SUPPLY_NODES, UNMETERED];
const DEMAND_ORDER: readonly DemandNode[] = [...DEMAND_NODES, UNMETERED];
const BALANCE_TOLERANCE = 1e-9;

export type NodeVector<K extends string> = Readonly<Record<K, number>>;

/** 공급·수요 합이 같은 두 벡터를 비례 할당한다. 합이 다르면 호출 오류다 (unmetered로 먼저 맞춘다) */
export function allocateProportional(supply: NodeVector<SupplyNode>, demand: NodeVector<DemandNode>): EnergyFlow[] {
  const total = SUPPLY_ORDER.reduce((sum, node) => sum + supply[node], 0);
  const demandTotal = DEMAND_ORDER.reduce((sum, node) => sum + demand[node], 0);
  if (Math.abs(total - demandTotal) > BALANCE_TOLERANCE * Math.max(1, total)) {
    throw new Error(`비례 할당: 공급 합(${total})과 수요 합(${demandTotal})이 다릅니다`);
  }
  if (!(total > 0)) return [];
  return SUPPLY_ORDER.flatMap((from) =>
    supply[from] > 0 ? DEMAND_ORDER.filter((to) => demand[to] > 0).map((to) => ({ from, to, kwh: (supply[from] * demand[to]) / total })) : [],
  );
}

export interface HourPool {
  readonly supply: NodeVector<SupplyNode>;
  readonly demand: NodeVector<DemandNode>;
  /** residual 방식에서 보조부하로 넘긴 잔여 */
  readonly auxResidual: number;
  /** SEC·P2P 분자용 전해조 에너지 (설비 전체 AC 우선) */
  readonly electrolyzerSystem: number;
  /** 전력 원천 행이 하나라도 있었는지. 없는 시간은 풀에서 뺀다(보조부하 추정만으로 unmetered가 생기지 않게) */
  readonly measured: boolean;
}

interface ElzBases {
  readonly flow: ElzPowerBasis | null;
  readonly energy: ElzPowerBasis | null;
}

function electrolyzerBases(ctx: LedgerContext): ElzBases {
  const rectifier = hasDayData(ctx, 'h2.elz.rectifier', 'ac.power');
  const system = hasDayData(ctx, 'h2.elz', 'ac.power');
  return {
    flow: rectifier ? 'rectifier_input' : system ? 'system_total' : null,
    energy: system ? 'system_total' : rectifier ? 'rectifier_input' : null,
  };
}

/** 한 시간 풀. 정류기·설비 전체 중 한쪽 행이 빠진 시간은 다른 쪽으로 대신한다 */
export function hourPool(ctx: LedgerContext, params: LedgerParams, hourStart: number): HourPool {
  const pv = signedEnergy(ctx, 'pv.inverter', 'ac.power', hourStart);
  const pcs = signedEnergy(ctx, 'ess.pcs', 'ac.power', hourStart);
  const fc = signedEnergy(ctx, 'fc.plant', 'fc.ac.power', hourStart);
  const grid = signedEnergy(ctx, 'grid.meter', 'ac.power', hourStart);
  const rectifier = signedEnergy(ctx, 'h2.elz.rectifier', 'ac.power', hourStart);
  const system = signedEnergy(ctx, 'h2.elz', 'ac.power', hourStart);
  const compressor = signedEnergy(ctx, 'h2.compressor', 'compressor.power', hourStart);

  const electrolyzer = rectifier.measured ? rectifier.pos : system.pos;
  const electrolyzerBop = rectifier.measured && system.measured ? Math.max(0, system.pos - rectifier.pos) : 0;
  const meteredAux = pv.neg + fc.neg + electrolyzerBop + (params.siteAuxKw ?? 0);

  const supplyMetered = pv.pos + pcs.pos + fc.pos + grid.neg;
  const demandMetered = pcs.neg + electrolyzer + compressor.pos + grid.pos + meteredAux;
  const imbalance = supplyMetered - demandMetered;
  const auxResidual = params.siteAuxKw === null ? Math.max(0, imbalance) : 0;

  return {
    supply: { pv: pv.pos, ess_discharge: pcs.pos, fc: fc.pos, grid_import: grid.neg, unmetered: Math.max(0, -imbalance) },
    demand: {
      site_aux: meteredAux + auxResidual,
      ess_charge: pcs.neg,
      electrolyzer,
      compressor: compressor.pos,
      grid_export: grid.pos,
      unmetered: params.siteAuxKw === null ? 0 : Math.max(0, imbalance),
    },
    auxResidual,
    electrolyzerSystem: system.measured ? system.pos : rectifier.pos,
    measured: [pv, pcs, fc, grid, rectifier, system, compressor].some((e) => e.measured),
  };
}

export interface EnergyPoolDay {
  readonly flows: readonly EnergyFlow[];
  readonly totals: EnergyTotals;
  readonly elzGridShare: number | null;
  readonly renewableShare: number | null;
  readonly dq: SiteEnergyDq['energy'];
}

const flowKey = (from: SupplyNode, to: DemandNode): string => `${from}>${to}`;

const COMPLETENESS_SOURCES: readonly (readonly [classKey: string, metricKey: string])[] = [
  ['pv.inverter', 'ac.power'],
  ['ess.pcs', 'ac.power'],
  ['fc.plant', 'fc.ac.power'],
  ['grid.meter', 'ac.power'],
  ['h2.elz.rectifier', 'ac.power'],
  ['h2.elz', 'ac.power'],
  ['h2.compressor', 'compressor.power'],
];

function sumFlows(pools: readonly HourPool[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const pool of pools) {
    for (const flow of allocateProportional(pool.supply, pool.demand)) {
      const key = flowKey(flow.from, flow.to);
      sums.set(key, (sums.get(key) ?? 0) + flow.kwh);
    }
  }
  return sums;
}

const nodeSum = <K extends string>(pools: readonly HourPool[], pick: (pool: HourPool) => NodeVector<K>, node: K): number =>
  pools.reduce((sum, pool) => sum + pick(pool)[node], 0);

function totalsOf(pools: readonly HourPool[]): EnergyTotals {
  const s = (node: SupplyNode) => nodeSum(pools, (p) => p.supply, node);
  const d = (node: DemandNode) => nodeSum(pools, (p) => p.demand, node);
  return {
    pv: round(s('pv'), 3),
    ess_discharge: round(s('ess_discharge'), 3),
    fc: round(s('fc'), 3),
    grid_import: round(s('grid_import'), 3),
    site_aux: round(d('site_aux'), 3),
    ess_charge: round(d('ess_charge'), 3),
    electrolyzer: round(d('electrolyzer'), 3),
    electrolyzer_system: round(pools.reduce((sum, p) => sum + p.electrolyzerSystem, 0), 3),
    compressor: round(d('compressor'), 3),
    grid_export: round(d('grid_export'), 3),
    unmetered_supply: round(s(UNMETERED), 3),
    unmetered_demand: round(d(UNMETERED), 3),
  };
}

/** 하루 에너지 풀: 흐름 합계(0.001 kWh 반올림, 0 흐름 제외), 노드 합계, 전해조 계통·재생 비율, 계측 품질 */
export function energyPool(ctx: LedgerContext, params: LedgerParams): EnergyPoolDay {
  const pools = ctx.hours.map((h) => hourPool(ctx, params, h)).filter((pool) => pool.measured);
  const sums = sumFlows(pools);
  const flows = SUPPLY_ORDER.flatMap((from) =>
    DEMAND_ORDER.flatMap((to) => {
      const kwh = round(sums.get(flowKey(from, to)) ?? 0, 3);
      return kwh > 0 ? [{ from, to, kwh }] : [];
    }),
  );
  const electrolyzerKwh = nodeSum(pools, (p) => p.demand, 'electrolyzer');
  const toElectrolyzer = (from: SupplyNode) => sums.get(flowKey(from, 'electrolyzer')) ?? 0;
  const hasElz = electrolyzerKwh >= params.minElzKwh;
  const poolTotal = SUPPLY_ORDER.reduce((sum, node) => sum + nodeSum(pools, (p) => p.supply, node), 0);
  const unmetered = nodeSum(pools, (p) => p.supply, UNMETERED) + nodeSum(pools, (p) => p.demand, UNMETERED);
  const bases = electrolyzerBases(ctx);
  const auxBasis: AuxBasis = params.siteAuxKw === null ? 'residual' : 'estimate';

  return {
    flows,
    totals: totalsOf(pools),
    elzGridShare: hasElz ? round(toElectrolyzer('grid_import') / electrolyzerKwh, 4) : null,
    renewableShare: hasElz ? round((toElectrolyzer('pv') + toElectrolyzer('ess_discharge')) / electrolyzerKwh, 4) : null,
    dq: {
      completeness: Object.fromEntries(
        COMPLETENESS_SOURCES.filter(([classKey]) => assetsOf(ctx, classKey).length > 0).map(([classKey, metricKey]) => {
          const value = dayCompleteness(ctx, classKey, metricKey);
          return [`${classKey}/${metricKey}`, value === null ? null : round(value, 4)];
        }),
      ),
      aux_basis: auxBasis,
      aux_residual_kwh: round(pools.reduce((sum, p) => sum + p.auxResidual, 0), 3),
      unmetered_kwh: round(unmetered, 3),
      unmetered_ratio: poolTotal > 0 ? round(unmetered / poolTotal, 5) : null,
      elz_flow_basis: bases.flow,
      elz_energy_basis: bases.energy,
    },
  };
}
