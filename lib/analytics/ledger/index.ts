// 사이트 에너지·수소 체인 원장 (설계 §3·§5.2 site_energy_daily, P3). 순수 모듈 — 입력 로드는 다음 단계 load 계층이 맡는다.
export { allocateProportional, energyPool, hourPool, type EnergyPoolDay, type HourPool, type NodeVector } from './allocation';
export { createLedgerContext, LEDGER_METRICS, type LedgerContext } from './hourly';
export {
  H2_ABEL_NOBLE_COVOLUME_M3_PER_KG,
  H2_EOS_VERSION,
  H2_KG_PER_AMP_HOUR_PER_CELL,
  H2_SPECIFIC_GAS_CONSTANT,
  h2DensityAbelNoble,
  h2MassAbelNobleKg,
  h2PressureAbelNobleBar,
  hydrogenLedger,
  storedDeltaKg,
  type HydrogenDay,
} from './hydrogen';
export { LEDGER_DEFAULTS, resolveLedgerParams, type LedgerParams } from './params';
export { estimateReferencePr, type PrReferenceEstimate, type PrReferenceInput } from './pr-reference';
export { claimLoss, PV_LOSS_ORDER, pvLossDay, type PvLossDay } from './pv-loss';
export { buildSiteEnergyDay, chainKpis, summarizeChainPeriod, type ChainKpis, type ChainPeriodSummary, type ChainSums, type SiteEnergyDayInput } from './site-day';
export * from './types';
