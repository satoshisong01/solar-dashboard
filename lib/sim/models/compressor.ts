// 수소 다이어프램 압축기 근사 모델 (순수 함수).
// 전력 = 고정분 + 질량유량 × 등온 등가 비일(ln 압력비) × (1 + 밸브 마모) / 효율, 토출 온도(유량·압력비·밸브 마모),
// 누설 감지 포트 압력(다이어프램·씰 누설 시 운전 중 상승), 씰 누설로 잃는 수소 비율(sealLossFraction).
import { clamp, lagToward, SECONDS_PER_HOUR } from '../math';
import { GAS_CONSTANT_J_PER_MOL_K, H2_MOLAR_MASS_KG_PER_MOL, KELVIN_OFFSET } from './common';

export interface CompressorParams {
  readonly ratedKw: number;
  readonly capacityKgH: number;
  readonly efficiency: number;
  readonly fixedKw: number;
  readonly idleKw: number;
  readonly dischargeMarginBar: number;
  /** 밸브 마모 1%당 토출 온도 상승 [K] (재압축·역류 가열) */
  readonly valveWearTempKPerPct: number;
  /** 정상 누설 감지 포트 압력 [bar] */
  readonly leakDetectBaseBar: number;
  /** 누설 감지 압력 1 bar당 씰로 잃는 수소 비율 */
  readonly sealLossPerBar: number;
  readonly maxSealLossFraction: number;
}

export interface CompressorState {
  readonly dischargeTempC: number;
  readonly leakDetectBar: number;
  readonly runHours: number;
  readonly energyKwh: number;
}

export interface CompressorInput {
  readonly running: boolean;
  /** 흡입 질량유량 [kg/h] */
  readonly flowKgH: number;
  readonly suctionBar: number;
  readonly dischargeBar: number;
  readonly ambientC: number;
  /** 밸브 마모 [비율] */
  readonly valveWear: number;
  /** 운전 중 누설 감지 포트 압력 상승분 [bar] */
  readonly sealLeakBar: number;
  readonly dtS: number;
}

export interface CompressorStep {
  readonly state: CompressorState;
  readonly powerKw: number;
}

export function compressorParams(nameplate: { ratedKw: number; capacityKgH: number }): CompressorParams {
  return {
    ratedKw: nameplate.ratedKw,
    capacityKgH: nameplate.capacityKgH,
    efficiency: 0.55,
    fixedKw: 2.5,
    idleKw: 0.3,
    dischargeMarginBar: 3,
    valveWearTempKPerPct: 0.8,
    leakDetectBaseBar: 0.05,
    sealLossPerBar: 0.001,
    maxSealLossFraction: 0.05,
  };
}

/** 다단 압축 등온 등가 비일 [J/kg] = (R·T/M)·ln(P2/P1) */
export function compressionWorkJPerKg(suctionBar: number, dischargeBar: number, suctionTempC: number): number {
  const ratio = Math.max(dischargeBar / Math.max(suctionBar, 1), 1);
  return ((GAS_CONSTANT_J_PER_MOL_K * (suctionTempC + KELVIN_OFFSET)) / H2_MOLAR_MASS_KG_PER_MOL) * Math.log(ratio);
}

/** 운전 중 압축한 수소 중 씰로 새는 비율 */
export const sealLossFraction = (params: CompressorParams, running: boolean, sealLeakBar: number): number =>
  running ? Math.min(params.maxSealLossFraction, params.sealLossPerBar * Math.max(0, sealLeakBar)) : 0;

export function stepCompressor(params: CompressorParams, state: CompressorState, input: CompressorInput): CompressorStep {
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const wear = Math.max(0, input.valveWear);
  const workJPerKg = compressionWorkJPerKg(input.suctionBar, input.dischargeBar, input.ambientC) * (1 + wear);
  const powerKw = input.running
    ? Math.min(params.ratedKw, params.fixedKw + ((input.flowKgH / SECONDS_PER_HOUR) * workJPerKg) / params.efficiency / 1000)
    : params.idleKw;
  const ratio = clamp(input.dischargeBar / Math.max(input.suctionBar, 1), 1, 100);
  const dischargeTargetC = input.running
    ? input.ambientC + 20 + 25 * (input.flowKgH / params.capacityKgH) + 12 * Math.log(ratio) + params.valveWearTempKPerPct * wear * 100
    : input.ambientC;
  const sealBar = Math.max(0, input.sealLeakBar);
  // 운전 중에는 누설분이 포트에 차오르고, 정지하면 벤트로 빠져 누설분의 10%만 남는다
  const leakTargetBar = params.leakDetectBaseBar + sealBar * (input.running ? 1 : 0.1);
  return {
    state: {
      dischargeTempC: lagToward(state.dischargeTempC, dischargeTargetC, input.dtS, input.running ? 600 : 1_800),
      leakDetectBar: lagToward(state.leakDetectBar, leakTargetBar, input.dtS, input.running ? 300 : 1_800),
      runHours: state.runHours + (input.running ? dtH : 0),
      energyKwh: state.energyKwh + powerKw * dtH,
    },
    powerKw,
  };
}
