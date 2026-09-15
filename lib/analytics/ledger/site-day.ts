// 사이트 하루 체인 원장 조립 (순수): 에너지 풀 + 수소 원장 + 체인 KPI + PV 미활용 분해 → SiteEnergyDay.
//
// 체인 KPI
//   전해조 SEC [kWh/kg]  = 전해조 설비 전체 AC kWh(없으면 정류기 입력) / 생산 kg
//   연료전지 [kg/MWh]    = 연료전지 수소 소비 kg / 연료전지 AC MWh
//   P2P 효율             = 연료전지 AC kWh / (연료전지 소비 kg × (전해조 + 압축기) kWh / 생산 kg)
//     재고 변화 보정: 분모에 기간 전해조·압축기 전력 전부를 쓰지 않고, 연료전지가 쓴 수소 kg에 같은 기간 평균 생산 원단위를 곱한다.
//     저장 재고가 늘거나 줄어든 몫의 전력은 분모에 섞이지 않는다. 가정: 재고로 꺼내 쓴 수소도 이번 기간 원단위로 만들어졌다.
//     하루 값은 생산·발전이 없는 날 비어 있으므로 판단에는 summarizeChainPeriod의 기간 합 값을 쓴다.
import { kstDateString } from '../types';
import { energyPool } from './allocation';
import { createLedgerContext, round, roundOrNull } from './hourly';
import { hydrogenLedger } from './hydrogen';
import { resolveLedgerParams, type LedgerParams } from './params';
import { pvLossDay } from './pv-loss';
import { ALLOC_VERSION, LEDGER_CALC_VERSION, type LedgerAsset, type LedgerHourRow, type PrReference, type SiteEnergyDay } from './types';

export interface SiteEnergyDayInput {
  /** KST 0시 (epoch ms) */
  readonly dayStart: number;
  readonly assets: readonly LedgerAsset[];
  /** [dayStart − 1 h, dayStart + 24 h) m_1h 행 */
  readonly rows: readonly LedgerHourRow[];
  /** params 값 또는 estimateReferencePr 결과. null이면 PV 미활용 분해를 하지 않는다 */
  readonly prRef: PrReference | null;
  /** pv.soiling_rate 탐지기 손실률 (인버터 id → 0~1). 비어 있으면 오염 손실은 미추정 */
  readonly soilingLossByAssetId?: ReadonlyMap<number, number>;
  readonly params?: Partial<LedgerParams>;
}

export interface ChainSums {
  readonly producedKg: number | null;
  readonly fcConsumedKg: number | null;
  readonly electrolyzerKwh: number;
  readonly compressorKwh: number;
  readonly fcAcKwh: number;
}

export interface ChainKpis {
  readonly elzSecKwhPerKg: number | null;
  readonly fcKgPerMwh: number | null;
  readonly p2pEfficiency: number | null;
}

export function chainKpis(sums: ChainSums, params: LedgerParams): ChainKpis {
  const produced = sums.producedKg !== null && sums.producedKg >= params.minKpiH2Kg ? sums.producedKg : null;
  const consumed = sums.fcConsumedKg !== null && sums.fcConsumedKg >= params.minKpiH2Kg ? sums.fcConsumedKg : null;
  const fcAc = sums.fcAcKwh >= params.minKpiFcKwh ? sums.fcAcKwh : null;
  const makeKwh = sums.electrolyzerKwh + sums.compressorKwh;
  return {
    elzSecKwhPerKg: produced !== null && sums.electrolyzerKwh > 0 ? round(sums.electrolyzerKwh / produced, 3) : null,
    fcKgPerMwh: consumed !== null && fcAc !== null ? round((consumed / fcAc) * 1000, 3) : null,
    p2pEfficiency: produced !== null && consumed !== null && fcAc !== null && makeKwh > 0 ? round(fcAc / ((consumed * makeKwh) / produced), 4) : null,
  };
}

export function buildSiteEnergyDay(input: SiteEnergyDayInput): SiteEnergyDay {
  const params = resolveLedgerParams(input.params);
  const ctx = createLedgerContext(input.dayStart, input.assets, input.rows, params.fallbackPeriodS);
  const energy = energyPool(ctx, params);
  const hydrogen = hydrogenLedger(ctx, params);
  const pv = pvLossDay(ctx, params, input.prRef, input.soilingLossByAssetId ?? new Map());
  const kpis = chainKpis(
    {
      producedKg: hydrogen.ledger.produced,
      fcConsumedKg: hydrogen.ledger.fc_consumed,
      electrolyzerKwh: energy.totals.electrolyzer_system,
      compressorKwh: energy.totals.compressor,
      fcAcKwh: energy.totals.fc,
    },
    params,
  );
  return {
    day: kstDateString(input.dayStart),
    flows_kwh: energy.flows,
    energy_kwh: energy.totals,
    h2_kg: hydrogen.ledger,
    elz_grid_share: energy.elzGridShare,
    renewable_share: energy.renewableShare,
    elz_sec_kwh_per_kg: kpis.elzSecKwhPerKg,
    fc_kg_per_mwh: kpis.fcKgPerMwh,
    p2p_efficiency: kpis.p2pEfficiency,
    pv_loss_kwh: pv.breakdown,
    dq: { energy: energy.dq, h2: hydrogen.dq, pv: pv.dq },
    alloc_version: ALLOC_VERSION,
    calc_version: LEDGER_CALC_VERSION,
  };
}

export interface ChainPeriodSummary extends ChainKpis {
  /** 수소 생산·소비·저장 변화가 모두 있는 날 수 (합계에 들어간 날) */
  readonly daysUsed: number;
  readonly producedKg: number;
  readonly fcConsumedKg: number;
  readonly residualKg: number;
  /** 기간 잔차 / max(생산, 소비, residualFloorKg) × 100 */
  readonly residualPct: number | null;
}

/** 기간 합 기준 체인 KPI와 물질수지 잔차. 수소 원장 값이 빠진 날은 에너지까지 함께 뺀다 */
export function summarizeChainPeriod(days: readonly SiteEnergyDay[], overrides: Partial<LedgerParams> = {}): ChainPeriodSummary {
  const params = resolveLedgerParams(overrides);
  const used = days.filter((d) => d.h2_kg.produced !== null && d.h2_kg.fc_consumed !== null && d.h2_kg.residual !== null);
  const sum = (pick: (d: SiteEnergyDay) => number) => used.reduce((acc, d) => acc + pick(d), 0);
  const producedKg = sum((d) => d.h2_kg.produced ?? 0);
  const fcConsumedKg = sum((d) => d.h2_kg.fc_consumed ?? 0);
  const residualKg = sum((d) => d.h2_kg.residual ?? 0);
  const kpis = chainKpis(
    { producedKg, fcConsumedKg, electrolyzerKwh: sum((d) => d.energy_kwh.electrolyzer_system), compressorKwh: sum((d) => d.energy_kwh.compressor), fcAcKwh: sum((d) => d.energy_kwh.fc) },
    params,
  );
  return {
    ...kpis,
    daysUsed: used.length,
    producedKg: round(producedKg, 4),
    fcConsumedKg: round(fcConsumedKg, 4),
    residualKg: round(residualKg, 4),
    residualPct: roundOrNull(used.length === 0 ? null : (residualKg / Math.max(producedKg, fcConsumedKg, params.residualFloorKg)) * 100, 3),
  };
}
