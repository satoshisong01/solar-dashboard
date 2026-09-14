// 수소 압축기 + 고압 저장뱅크 근사 모델 (순수 함수).
// 질량수지 dm/dt = in − out − leak, 압력 P = Z·m·R·T/(M·V) (Z는 제2 비리얼 계수 간이식),
// 압축기 전력 ∝ 질량유량 × ln(압력비), 토출온도, 탱크 온도.
import { clamp, lagToward, SECONDS_PER_DAY, SECONDS_PER_HOUR } from '../math';
import { GAS_CONSTANT_J_PER_MOL_K, H2_MOLAR_MASS_KG_PER_MOL, KELVIN_OFFSET } from './common';

/** 수소 제2 비리얼 계수 B [m³/mol] (상온 약 14~15 cm³/mol) */
const H2_SECOND_VIRIAL_M3_PER_MOL = 14.5e-6;
const PA_PER_BAR = 1e5;

export interface StorageParams {
  readonly volumeM3: number;
  readonly maxBar: number;
  /** 이 압력 아래로는 인출하지 않는다 (용기 최소 잔압) */
  readonly minBar: number;
  readonly compressorRatedKw: number;
  readonly compressorCapacityKgH: number;
  readonly compressorEfficiency: number;
  readonly compressorFixedKw: number;
  readonly compressorIdleKw: number;
  readonly dischargeMarginBar: number;
  readonly thermalTauS: number;
  /** 순유입 1 kg/h당 가스 평형 온도 상승 [K] */
  readonly fillHeatingKPerKgH: number;
}

export interface StorageState {
  readonly massKg: number;
  readonly gasTempC: number;
  readonly compressorOn: boolean;
  readonly compressorRunHours: number;
  readonly compressorEnergyKwh: number;
  readonly dischargeTempC: number;
}

export interface StorageInput {
  /** 전해조 제품 수소 [kg/h] */
  readonly inflowKgH: number;
  /** 연료전지 수요 [kg/h] */
  readonly outflowKgH: number;
  readonly suctionBar: number;
  readonly ambientC: number;
  readonly leakKgPerDay: number;
  readonly dtS: number;
}

export interface StorageStep {
  readonly state: StorageState;
  readonly pressureBar: number;
  readonly inKg: number;
  readonly outKg: number;
  readonly leakKg: number;
  /** 저장 불가(만충·압축기 용량 초과)로 배출한 양 */
  readonly ventedKg: number;
  readonly outflowLimited: boolean;
  readonly compressorKw: number;
  readonly compressorFlowKgH: number;
  readonly dischargeBar: number;
}

export function storageParams(bank: { waterVolumeL: number; maxBar: number }, compressor: { ratedKw: number; capacityKgH: number }): StorageParams {
  return {
    volumeM3: bank.waterVolumeL / 1000,
    maxBar: bank.maxBar,
    minBar: 30,
    compressorRatedKw: compressor.ratedKw,
    compressorCapacityKgH: compressor.capacityKgH,
    compressorEfficiency: 0.55,
    compressorFixedKw: 2.5,
    compressorIdleKw: 0.3,
    dischargeMarginBar: 3,
    thermalTauS: 7_200,
    fillHeatingKPerKgH: 0.8,
  };
}

/** Z = 1/(1 − B·c), c = 몰 밀도 [mol/m³] */
export const h2Compressibility = (molarDensity: number): number => 1 / (1 - H2_SECOND_VIRIAL_M3_PER_MOL * molarDensity);

/** P = Z·c·R·T = Z·m·R·T/(M·V) [bar] */
export function h2PressureBar(massKg: number, volumeM3: number, tempC: number): number {
  const molarDensity = massKg / H2_MOLAR_MASS_KG_PER_MOL / volumeM3;
  const pressurePa = h2Compressibility(molarDensity) * molarDensity * GAS_CONSTANT_J_PER_MOL_K * (tempC + KELVIN_OFFSET);
  return pressurePa / PA_PER_BAR;
}

/** 압력·온도 → 질량 [kg]: P(1 − B·c) = c·R·T → c = P/(R·T + P·B) */
export function h2MassKg(pressureBar: number, volumeM3: number, tempC: number): number {
  const pressurePa = pressureBar * PA_PER_BAR;
  const molarDensity = pressurePa / (GAS_CONSTANT_J_PER_MOL_K * (tempC + KELVIN_OFFSET) + pressurePa * H2_SECOND_VIRIAL_M3_PER_MOL);
  return molarDensity * volumeM3 * H2_MOLAR_MASS_KG_PER_MOL;
}

/** 다단 압축 등온 등가 비일 [J/kg] = (R·T/M)·ln(P2/P1) */
export function compressionWorkJPerKg(suctionBar: number, dischargeBar: number, suctionTempC: number): number {
  const ratio = Math.max(dischargeBar / Math.max(suctionBar, 1), 1);
  return ((GAS_CONSTANT_J_PER_MOL_K * (suctionTempC + KELVIN_OFFSET)) / H2_MOLAR_MASS_KG_PER_MOL) * Math.log(ratio);
}

export function stepStorage(params: StorageParams, state: StorageState, input: StorageInput): StorageStep {
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const pressureBar = h2PressureBar(state.massKg, params.volumeM3, state.gasTempC);
  const compressorOn = input.inflowKgH > 1e-6 && pressureBar < params.maxBar;
  const requestedInKg = Math.max(0, input.inflowKgH) * dtH;
  const inKg = compressorOn ? Math.min(requestedInKg, params.compressorCapacityKgH * dtH) : 0;
  const availableKg = Math.max(0, state.massKg - h2MassKg(params.minBar, params.volumeM3, state.gasTempC));
  const requestedOutKg = Math.max(0, input.outflowKgH) * dtH;
  const outKg = Math.min(requestedOutKg, availableKg);
  const leakKg = Math.min((Math.max(0, input.leakKgPerDay) * input.dtS) / SECONDS_PER_DAY, state.massKg - outKg);
  const massKg = state.massKg + inKg - outKg - leakKg;

  const netFlowKgH = (inKg - outKg) / Math.max(dtH, 1e-9);
  const gasTargetC = input.ambientC + params.fillHeatingKPerKgH * netFlowKgH;
  const gasTempC = lagToward(state.gasTempC, gasTargetC, input.dtS, params.thermalTauS);
  const dischargeBar = pressureBar + (compressorOn ? params.dischargeMarginBar : 0);
  const flowKgH = inKg / Math.max(dtH, 1e-9);
  const workJPerKg = compressionWorkJPerKg(input.suctionBar, dischargeBar, input.ambientC);
  const compressorKw = compressorOn
    ? Math.min(params.compressorRatedKw, params.compressorFixedKw + ((flowKgH / SECONDS_PER_HOUR) * workJPerKg) / params.compressorEfficiency / 1000)
    : params.compressorIdleKw;
  const ratio = clamp(dischargeBar / Math.max(input.suctionBar, 1), 1, 100);
  const dischargeTargetC = compressorOn
    ? input.ambientC + 20 + 25 * (flowKgH / params.compressorCapacityKgH) + 12 * Math.log(ratio)
    : input.ambientC;

  return {
    state: {
      massKg,
      gasTempC,
      compressorOn,
      compressorRunHours: state.compressorRunHours + (compressorOn ? dtH : 0),
      compressorEnergyKwh: state.compressorEnergyKwh + compressorKw * dtH,
      dischargeTempC: lagToward(state.dischargeTempC, dischargeTargetC, input.dtS, compressorOn ? 600 : 1_800),
    },
    pressureBar: h2PressureBar(massKg, params.volumeM3, gasTempC),
    inKg,
    outKg,
    leakKg,
    ventedKg: requestedInKg - inKg,
    outflowLimited: outKg < requestedOutKg,
    compressorKw,
    compressorFlowKgH: flowKgH,
    dischargeBar,
  };
}
