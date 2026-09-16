// 탐지기 레지스트리: P2 6종 + P3 8종 + 가평 구성 3종 (설계 §5.3 로드맵). 입력 로드는 load 계층(파이프라인 단계)이 구현한다.
// 각 탐지기는 requires(설비 종류·필수/권장 메트릭·메트릭별 샘플 주기 상한·최소 데이터 기간 — 탐지 준비도 매트릭스)와
// paramSchema(파라미터별 기본값·min·max·label·unit·description — 탐지기 설정 UI)를 가진다.
import { compSecRise } from './comp-sec-rise';
import { dqGapFlatline } from './dq-gap-flatline';
import { elSecRise } from './el-sec-rise';
import { essCapacityFade } from './ess-capacity-fade';
import { essCellImbalance } from './ess-cell-imbalance';
import { essResistanceGrowth } from './ess-resistance-growth';
import { fcBlowerWear } from './fc-blower-wear';
import { h2ChainMassBalanceGap } from './h2chain-mass-balance';
import { hxFouling } from './hx-fouling';
import { o2PurityDrift } from './o2-purity-drift';
import { prvSeatLeak } from './prv-seat-leak';
import { invThermalDerating } from './inv-thermal-derating';
import { pvInverterPeer } from './pv-inverter-peer';
import { pvSoilingRate } from './pv-soiling-rate';
import { elVoltageRise, fcVoltageDecay } from './stack-detectors';
import { tankStaticLeak } from './tank-static-leak';

export const P2_DETECTORS = Object.freeze([dqGapFlatline, essCapacityFade, essCellImbalance, pvInverterPeer, elVoltageRise, fcVoltageDecay] as const);

export type P2DetectorId = (typeof P2_DETECTORS)[number]['id'];

export const P3_DETECTORS = Object.freeze([elSecRise, h2ChainMassBalanceGap, tankStaticLeak, compSecRise, fcBlowerWear, pvSoilingRate, essResistanceGrowth, invThermalDerating] as const);

export type P3DetectorId = (typeof P3_DETECTORS)[number]['id'];

/** 가평 P&ID 구성 탐지기 3종 (감압밸브 시트 누설·폐열회수 열교환기 성능 저하·산소 중 수소 상승) */
export const GAPYEONG_DETECTORS = Object.freeze([prvSeatLeak, hxFouling, o2PurityDrift] as const);

export type GapyeongDetectorId = (typeof GAPYEONG_DETECTORS)[number]['id'];

/** 전체 탐지기 17종 (설정 UI·탐지 준비도 매트릭스가 순회한다) */
export const DETECTORS = Object.freeze([...P2_DETECTORS, ...P3_DETECTORS, ...GAPYEONG_DETECTORS] as const);

export type DetectorId = P2DetectorId | P3DetectorId | GapyeongDetectorId;

export { compSecRise, COMP_SEC_RISE_DEFAULTS, COMP_SEC_RISE_PARAM_SCHEMA, type CompSecRiseInput, type CompSecRiseParams } from './comp-sec-rise';
export { dqGapFlatline, DQ_GAP_FLATLINE_DEFAULTS, DQ_GAP_FLATLINE_PARAM_SCHEMA, type DqGapFlatlineInput, type DqGapFlatlineParams, type DqPointSummary } from './dq-gap-flatline';
export { elSecRise, EL_SEC_RISE_DEFAULTS, EL_SEC_RISE_PARAM_SCHEMA, type ElSecRiseInput, type ElSecRiseParams } from './el-sec-rise';
export { capacityChecks, type CapacityCheckParams } from './ess-capacity-checks';
export { essCapacityFade, ESS_CAPACITY_DEFAULTS, ESS_CAPACITY_PARAM_SCHEMA, type EssCapacityInput, type EssCapacityParams } from './ess-capacity-fade';
export { cellDvPoints, essCellImbalance, ESS_CELL_IMBALANCE_DEFAULTS, ESS_CELL_IMBALANCE_PARAM_SCHEMA, type CellDvPoint, type EssCellImbalanceInput, type EssCellImbalanceParams } from './ess-cell-imbalance';
export { essResistanceGrowth, ESS_RESISTANCE_DEFAULTS, ESS_RESISTANCE_PARAM_SCHEMA, type EssResistanceInput, type EssResistanceParams } from './ess-resistance-growth';
export { fcBlowerWear, FC_BLOWER_WEAR_DEFAULTS, FC_BLOWER_WEAR_PARAM_SCHEMA, type FcBlowerWearInput, type FcBlowerWearParams } from './fc-blower-wear';
export { H2_MASS_BALANCE_DEFAULTS, H2_MASS_BALANCE_PARAM_SCHEMA, h2ChainMassBalanceGap, type H2LedgerDayInput, type H2MassBalanceInput, type H2MassBalanceParams, type StaticLeakCrossCheck } from './h2chain-mass-balance';
export { ABEL_NOBLE_DEFAULTS, H2_KG_PER_AMP_HOUR_PER_CELL, h2DensityKgM3, h2DensityPerBar, h2MassKg, h2PressureBar, type AbelNobleConstants } from './hydrogen-eos';
export { HX_FOULING_DEFAULTS, HX_FOULING_PARAM_SCHEMA, hxFouling, lmtd, type HxFoulingInput, type HxFoulingParams } from './hx-fouling';
export { O2_PURITY_DRIFT_DEFAULTS, O2_PURITY_DRIFT_PARAM_SCHEMA, o2PurityDrift, type O2PurityDriftInput, type O2PurityDriftParams } from './o2-purity-drift';
export { creepToNlPerMin, PRV_SEAT_LEAK_DEFAULTS, PRV_SEAT_LEAK_PARAM_SCHEMA, prvSeatLeak, type PrvSeatLeakInput, type PrvSeatLeakParams } from './prv-seat-leak';
export { INV_THERMAL_DERATING_DEFAULTS, INV_THERMAL_DERATING_PARAM_SCHEMA, invThermalDerating, type InverterFaultEvent, type InvThermalDeratingInput, type InvThermalDeratingParams, type ThermalInverter } from './inv-thermal-derating';
export type { ParamMeta } from './param-schema';
export { pvInverterPeer, PV_INVERTER_PEER_DEFAULTS, PV_INVERTER_PEER_PARAM_SCHEMA, type PvInverterPeerInput, type PvInverterPeerParams } from './pv-inverter-peer';
export { FAST_S, metricRequirementText, recommended, required, SLOW_S } from './requirements';
export { PV_SOILING_DEFAULTS, PV_SOILING_PARAM_SCHEMA, pvSoilingRate, type PvSoilingInput, type PvSoilingParams } from './pv-soiling-rate';
export { EL_VOLTAGE_RISE_DEFAULTS, EL_VOLTAGE_RISE_PARAM_SCHEMA, elVoltageRise, FC_VOLTAGE_DECAY_DEFAULTS, FC_VOLTAGE_DECAY_PARAM_SCHEMA, fcVoltageDecay, type StackDetectorParams, type StackVoltageInput } from './stack-detectors';
export { pressureCrossChecks, type PressureCrossCheck, type PressureCrossSource } from './tank-peer-pressure';
export { TANK_STATIC_LEAK_DEFAULTS, TANK_STATIC_LEAK_PARAM_SCHEMA, tankStaticLeak, type TankHoldInput, type TankStaticLeakInput, type TankStaticLeakParams } from './tank-static-leak';
export type * from './types';
