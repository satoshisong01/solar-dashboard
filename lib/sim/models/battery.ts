// LFP 배터리 랙 근사 모델 (순수 함수).
// SOC 적분 · OCV(SOC) · 내부저항(Arrhenius) · CC-CV · 저온 용량 감소 · 셀 통계(편차) · SOH(용량 감소율).
// 셀 편차는 두 가지: SOC 차이(cellImbalance, OCV 곡선을 따라 SOC에 따라 달라짐)와 전압 산포 추가분(extraCellSpreadV, SOC와 무관).
import { clamp, interpolate, lagToward, SECONDS_PER_DAY, SECONDS_PER_HOUR, type Table } from '../math';
import { KELVIN_OFFSET } from './common';

/** LFP 셀 휴지 개방전압 곡선 근사: 10~90% 구간이 평탄하다 */
const LFP_OCV_TABLE: Table = [
  [0, 2.8],
  [0.05, 3.1],
  [0.1, 3.2],
  [0.2, 3.25],
  [0.35, 3.28],
  [0.5, 3.29],
  [0.65, 3.31],
  [0.8, 3.33],
  [0.9, 3.34],
  [0.95, 3.37],
  [1, 3.45],
];
const LFP_NOMINAL_CELL_V = 3.2;
/** 내부저항 온도 의존 (Ea/R, K) */
const RESISTANCE_ACTIVATION_K = 2_500;
const MIN_SOH = 0.5;
/** SOC가 같아도 제조 편차로 생기는 셀 전압 산포(최고−최저) [V] */
const CELL_BASE_SPREAD_V = 0.005;

export interface RackParams {
  /** 랙 정격 용량 [Ah] (병렬 합) */
  readonly capacityAh: number;
  readonly cellsSeries: number;
  readonly cellsParallel: number;
  /** 25 °C 셀 1개 내부저항 [Ω] */
  readonly cellResistance25COhm: number;
  readonly cellVoltageMaxV: number;
  readonly cellVoltageMinV: number;
  readonly maxCRate: number;
  readonly thermalCapacityJPerK: number;
  readonly coolingTauS: number;
  readonly coulombicEfficiency: number;
}

export interface RackState {
  /** 0~1 */
  readonly soc: number;
  /** 0~1 (정격 대비 가용 용량) */
  readonly soh: number;
  readonly tempC: number;
}

export interface RackInput {
  /** DC 전력 명령 [kW], 충전 + */
  readonly powerKw: number;
  readonly roomTempC: number;
  /** 하루당 용량 감소 비율 (0.0001 = 0.01%/일) */
  readonly capacityFadePerDay: number;
  /** 최강·최약 셀 SOC 차이 (0.02 = 2%) */
  readonly cellImbalance: number;
  /** 최고·최저 셀 전압 산포 추가분 [V] — 밸런싱 불량 고장 주입용. 최고 셀 +절반, 최저 셀 −절반 (생략 0) */
  readonly extraCellSpreadV?: number;
  readonly dtS: number;
}

export type RackMode = 'idle' | 'cc' | 'cv' | 'discharge';

export interface RackStep {
  readonly state: RackState;
  readonly mode: RackMode;
  /** 충전 + */
  readonly currentA: number;
  readonly voltageV: number;
  /** 충전 + */
  readonly powerKw: number;
  readonly ocvV: number;
  readonly cellVoltageMaxV: number;
  readonly cellVoltageMinV: number;
  readonly cellVoltageAvgV: number;
  readonly cellTempMaxC: number;
  readonly cellTempMinC: number;
  readonly cellTempAvgC: number;
  readonly chargeLimitA: number;
  readonly dischargeLimitA: number;
}

/** 랙 명판(용량·직병렬 수)에 LFP 기본 특성을 더한다. */
export function rackParams(capacityAh: number, cellsSeries: number, cellsParallel: number): RackParams {
  const cellCount = cellsSeries * cellsParallel;
  return {
    capacityAh,
    cellsSeries,
    cellsParallel,
    cellResistance25COhm: 0.000_25, // 300 Ah 각형 셀 수준
    cellVoltageMaxV: 3.55,
    cellVoltageMinV: 2.9,
    maxCRate: 0.5,
    thermalCapacityJPerK: cellCount * 5.4 * 1_100, // 셀 5.4 kg × 비열 1100 J/(kg·K)
    coolingTauS: 3_600,
    coulombicEfficiency: 0.995,
  };
}

export const lfpOcvV = (soc: number): number => interpolate(LFP_OCV_TABLE, clamp(soc, 0, 1));

export const nominalRackVoltageV = (params: RackParams): number => params.cellsSeries * LFP_NOMINAL_CELL_V;

export function cellResistanceOhm(params: RackParams, tempC: number): number {
  const inverseDelta = 1 / (tempC + KELVIN_OFFSET) - 1 / (25 + KELVIN_OFFSET);
  return params.cellResistance25COhm * Math.exp(RESISTANCE_ACTIVATION_K * inverseDelta);
}

/** 저온에서 쓸 수 있는 용량이 줄어든다 (25 °C 미만 1 °C당 0.6%, 최소 70%). */
export const temperatureCapacityFactor = (tempC: number): number =>
  tempC >= 25 ? 1 : Math.max(0.7, 1 - 0.006 * (25 - tempC));

/** BMS 충방전 전류 한계(CCL/DCL): 저온·고온·SOC 끝단에서 줄인다. */
export function currentLimitsA(params: RackParams, state: RackState): { chargeA: number; dischargeA: number } {
  const base = params.maxCRate * params.capacityAh * state.soh;
  const coldDerate = clamp(state.tempC / 10, 0.1, 1);
  const hotCutoff = state.tempC >= 50 ? 0 : 1;
  const chargeTaper = clamp((1 - state.soc) / 0.05, 0, 1);
  const dischargeTaper = clamp(state.soc / 0.05, 0, 1);
  return {
    chargeA: base * coldDerate * hotCutoff * chargeTaper,
    dischargeA: base * Math.max(coldDerate, 0.5) * hotCutoff * dischargeTaper,
  };
}

/** P = Ns·I·(OCV + I·R/Np) → a·I² + b·I − P = 0 의 해 */
function currentForPowerA(params: RackParams, ocvV: number, resistanceOhm: number, powerKw: number): number {
  const a = (params.cellsSeries * resistanceOhm) / params.cellsParallel;
  const b = params.cellsSeries * ocvV;
  const discriminant = b * b + 4 * a * powerKw * 1000;
  if (discriminant <= 0) return -b / (2 * a); // 낼 수 있는 최대 방전 전력 지점
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

function limitCurrent(
  requestedA: number,
  limits: { chargeA: number; dischargeA: number },
  cvLimitA: number,
  undervoltageLimitA: number,
): { currentA: number; mode: RackMode } {
  if (requestedA > 0) {
    const ccA = Math.min(requestedA, limits.chargeA);
    if (cvLimitA < ccA) return { currentA: cvLimitA, mode: cvLimitA > 0 ? 'cv' : 'idle' };
    return { currentA: ccA, mode: ccA > 0 ? 'cc' : 'idle' };
  }
  if (requestedA < 0) {
    const currentA = Math.max(requestedA, -limits.dischargeA, -undervoltageLimitA);
    return { currentA, mode: currentA < 0 ? 'discharge' : 'idle' };
  }
  return { currentA: 0, mode: 'idle' };
}

export function stepRack(params: RackParams, state: RackState, input: RackInput): RackStep {
  const limits = currentLimitsA(params, state);
  const resistance = cellResistanceOhm(params, state.tempC);
  const bundleResistance = resistance / params.cellsParallel; // 셀 전압 = OCV + I × R/Np
  const spread = clamp(input.cellImbalance, 0, 0.5);
  const halfVoltageSpreadV = (CELL_BASE_SPREAD_V + Math.max(0, input.extraCellSpreadV ?? 0)) / 2;
  const ocvV = lfpOcvV(state.soc);
  const strongOcv = lfpOcvV(state.soc + spread / 2);
  const weakOcv = lfpOcvV(state.soc - spread / 2);
  // CV: 가장 높은 셀이 충전 상한에, 방전: 가장 낮은 셀이 방전 하한에 닿는 전류
  const cvLimitA = Math.max(0, (params.cellVoltageMaxV - halfVoltageSpreadV - strongOcv) / bundleResistance);
  const undervoltageLimitA = Math.max(0, (weakOcv - halfVoltageSpreadV - params.cellVoltageMinV) / bundleResistance);
  const requestedA = currentForPowerA(params, ocvV, resistance, input.powerKw);
  const { currentA, mode } = limitCurrent(requestedA, limits, cvLimitA, undervoltageLimitA);

  const dtH = input.dtS / SECONDS_PER_HOUR;
  const effectiveAh = params.capacityAh * state.soh * temperatureCapacityFactor(state.tempC);
  const chargedAh = currentA * dtH * (currentA > 0 ? params.coulombicEfficiency : 1);
  const heatW = currentA * currentA * params.cellsSeries * bundleResistance;
  const equilibriumC = input.roomTempC + (heatW * params.coolingTauS) / params.thermalCapacityJPerK;
  const nextState: RackState = {
    soc: clamp(state.soc + chargedAh / effectiveAh, 0, 1),
    soh: clamp(state.soh - (Math.max(0, input.capacityFadePerDay) * input.dtS) / SECONDS_PER_DAY, MIN_SOH, 1),
    tempC: lagToward(state.tempC, equilibriumC, input.dtS, params.coolingTauS),
  };

  const irDropV = currentA * bundleResistance;
  const cellVoltageAvgV = ocvV + irDropV;
  const absCurrent = Math.abs(currentA);
  return {
    state: nextState,
    mode,
    currentA,
    voltageV: params.cellsSeries * cellVoltageAvgV,
    powerKw: (params.cellsSeries * cellVoltageAvgV * currentA) / 1000,
    ocvV,
    cellVoltageMaxV: Math.max(cellVoltageAvgV, strongOcv + irDropV) + halfVoltageSpreadV,
    cellVoltageMinV: Math.min(cellVoltageAvgV, weakOcv + irDropV) - halfVoltageSpreadV,
    cellVoltageAvgV,
    cellTempMaxC: nextState.tempC + 1.0 + 0.004 * absCurrent,
    cellTempMinC: nextState.tempC - 0.8 - 0.001 * absCurrent,
    cellTempAvgC: nextState.tempC,
    chargeLimitA: limits.chargeA,
    dischargeLimitA: limits.dischargeA,
  };
}
