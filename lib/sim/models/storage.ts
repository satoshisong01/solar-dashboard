// 고압 수소 저장뱅크(용기 N개) + 압축기 근사 모델 (순수 함수).
// 질량수지: 용기마다 dm/dt = 유입 − 유출 − 누설. 유입 = 압축기가 받은 전해조 제품 수소 − 씰 누설, 유출 = 연료전지 공급.
//   충전·인출 중에는 용기 차단밸브가 모두 열려 압력(= 질량, 용기·온도가 같으므로)이 같아지고,
//   정지 보유 중에는 용기별 차단밸브를 닫아 용기마다 따로 줄어든다(누설 용기만 압력이 떨어진다).
// 압력: 실기체 상태식(h2-eos.ts 참값). 온도: 2절점 열모델
//   벽(강재 열용량) ← 주변 온도(외기 + 일사 가열 + 일교차 확대 대조군), 시정수 6 h
//   가스 ← 벽 온도 + 충전 압축열(유입 kg/h 비례) − 인출 팽창 냉각, 시정수 45 min
import { lagToward, SECONDS_PER_DAY, SECONDS_PER_HOUR } from '../math';
import { compressorParams, sealLossFraction, stepCompressor, type CompressorParams, type CompressorState } from './compressor';
import { h2MassKg, h2PressureBar } from './h2-eos';

export interface StorageParams {
  readonly tankCount: number;
  readonly tankVolumeM3: number;
  readonly maxBar: number;
  /** 이 압력 아래로는 인출하지 않는다 (용기 최소 잔압) */
  readonly minBar: number;
  readonly compressor: CompressorParams;
  readonly gasTauS: number;
  readonly wallTauS: number;
  /** 벽 목표 온도에 섞이는 가스 온도 비율 (가스 → 벽 열전달) */
  readonly wallGasCoupling: number;
  /** 유입 1 kg/h당 가스 평형 온도 상승 [K] (용기 안 압축열) */
  readonly fillHeatingKPerKgH: number;
  /** 인출 1 kg/h당 가스 평형 온도 하강 [K] (팽창 냉각) */
  readonly drawCoolingKPerKgH: number;
}

export interface StorageState {
  /** 용기별 수소 질량 [kg] */
  readonly tankMassKg: readonly number[];
  readonly gasTempC: number;
  readonly wallTempC: number;
  readonly valvesOpen: boolean;
  readonly compressorOn: boolean;
  readonly compressor: CompressorState;
}

export interface StorageInput {
  /** 전해조 제품 수소 [kg/h] */
  readonly inflowKgH: number;
  /** 연료전지 수요 [kg/h] */
  readonly outflowKgH: number;
  readonly suctionBar: number;
  readonly ambientC: number;
  /** 용기 주변 온도 [°C] (외기 + 일사 가열 + 일교차 확대) */
  readonly envTempC: number;
  /** 용기별 누설 [kg/일] (길이 = tankCount) */
  readonly tankLeakKgPerDay: readonly number[];
  readonly valveWear: number;
  readonly sealLeakBar: number;
  readonly dtS: number;
}

export interface StorageStep {
  readonly state: StorageState;
  /** 용기 압력 평균 [bar] (밸브가 열려 있으면 모든 용기가 같다) */
  readonly pressureBar: number;
  readonly tankPressureBar: readonly number[];
  /** 용기에 들어간 양 (씰 누설 제외) */
  readonly inKg: number;
  readonly outKg: number;
  readonly leakKg: number;
  readonly tankLeakKg: readonly number[];
  /** 저장 불가(만충·압축기 용량 초과)로 배출한 양 */
  readonly ventedKg: number;
  /** 압축기 씰로 샌 양 */
  readonly sealLossKg: number;
  readonly outflowLimited: boolean;
  readonly compressorKw: number;
  readonly compressorFlowKgH: number;
  readonly dischargeBar: number;
}

export function storageParams(bank: { tankCount: number; tankWaterVolumeL: number; maxBar: number }, compressor: { ratedKw: number; capacityKgH: number }): StorageParams {
  if (!Number.isInteger(bank.tankCount) || bank.tankCount < 1) throw new Error(`저장용기 수는 1 이상의 정수여야 합니다: ${bank.tankCount}`);
  return {
    tankCount: bank.tankCount,
    tankVolumeM3: bank.tankWaterVolumeL / 1000,
    maxBar: bank.maxBar,
    minBar: 30,
    compressor: compressorParams(compressor),
    gasTauS: 2_700,
    wallTauS: 21_600,
    wallGasCoupling: 0.2,
    fillHeatingKPerKgH: 0.8,
    drawCoolingKPerKgH: 0.5,
  };
}

/** 모든 용기가 같은 압력·온도인 초기 상태 */
export function initialStorageState(params: StorageParams, pressureBar: number, tempC: number, compressor: Pick<CompressorState, 'runHours' | 'energyKwh'>): StorageState {
  const massKg = h2MassKg(pressureBar, params.tankVolumeM3, tempC);
  return {
    tankMassKg: Array.from({ length: params.tankCount }, () => massKg),
    gasTempC: tempC,
    wallTempC: tempC,
    valvesOpen: false,
    compressorOn: false,
    compressor: { ...compressor, dischargeTempC: tempC, leakDetectBar: params.compressor.leakDetectBaseBar },
  };
}

const sum = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);
export const totalMassKg = (state: Pick<StorageState, 'tankMassKg'>): number => sum(state.tankMassKg);

interface Transfer {
  readonly compressorOn: boolean;
  readonly inKg: number;
  readonly outKg: number;
  readonly ventedKg: number;
  readonly sealLossKg: number;
  readonly outflowLimited: boolean;
}

function transfer(params: StorageParams, state: StorageState, input: StorageInput, bankBar: number): Transfer {
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const compressorOn = input.inflowKgH > 1e-6 && bankBar < params.maxBar;
  const requestedInKg = Math.max(0, input.inflowKgH) * dtH;
  const compressedKg = compressorOn ? Math.min(requestedInKg, params.compressor.capacityKgH * dtH) : 0;
  const sealLossKg = compressedKg * sealLossFraction(params.compressor, compressorOn, input.sealLeakBar);
  const minMassKg = h2MassKg(params.minBar, params.tankVolumeM3, state.gasTempC);
  const availableKg = sum(state.tankMassKg.map((m) => Math.max(0, m - minMassKg)));
  const requestedOutKg = Math.max(0, input.outflowKgH) * dtH;
  const outKg = Math.min(requestedOutKg, availableKg);
  return { compressorOn, inKg: compressedKg - sealLossKg, outKg, ventedKg: requestedInKg - compressedKg, sealLossKg, outflowLimited: outKg < requestedOutKg };
}

/** 누설을 뺀 뒤, 밸브가 열려 있으면 유입·유출을 더해 용기끼리 고르게 나누고, 닫혀 있으면 용기마다 따로 둔다 */
function nextMasses(masses: readonly number[], leaks: readonly number[], flow: Transfer, valvesOpen: boolean): number[] {
  const leaked = masses.map((m, i) => m - (leaks[i] ?? 0));
  if (!valvesOpen) return leaked;
  const each = (sum(leaked) + flow.inKg - flow.outKg) / leaked.length;
  return leaked.map(() => each);
}

export function stepStorage(params: StorageParams, state: StorageState, input: StorageInput): StorageStep {
  if (input.tankLeakKgPerDay.length !== params.tankCount) throw new Error(`용기별 누설 길이(${input.tankLeakKgPerDay.length})가 용기 수(${params.tankCount})와 다릅니다`);
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const pressuresBefore = state.tankMassKg.map((m) => h2PressureBar(m, params.tankVolumeM3, state.gasTempC));
  const bankBar = sum(pressuresBefore) / params.tankCount;
  const flow = transfer(params, state, input, bankBar);
  const dischargeBar = bankBar + (flow.compressorOn ? params.compressor.dischargeMarginBar : 0);
  const compressor = stepCompressor(params.compressor, state.compressor, {
    running: flow.compressorOn,
    flowKgH: (flow.inKg + flow.sealLossKg) / Math.max(dtH, 1e-9),
    suctionBar: input.suctionBar,
    dischargeBar,
    ambientC: input.ambientC,
    valveWear: input.valveWear,
    sealLeakBar: input.sealLeakBar,
    dtS: input.dtS,
  });
  const valvesOpen = flow.compressorOn || flow.outKg > 0;
  const tankLeakKg = state.tankMassKg.map((m, i) => Math.min((Math.max(0, input.tankLeakKgPerDay[i] ?? 0) * input.dtS) / SECONDS_PER_DAY, m));
  const tankMassKg = nextMasses(state.tankMassKg, tankLeakKg, flow, valvesOpen);

  const netHeatingK = (params.fillHeatingKPerKgH * flow.inKg - params.drawCoolingKPerKgH * flow.outKg) / Math.max(dtH, 1e-9);
  const gasTempC = lagToward(state.gasTempC, state.wallTempC + netHeatingK, input.dtS, params.gasTauS);
  const wallTarget = input.envTempC + params.wallGasCoupling * (state.gasTempC - input.envTempC);
  const wallTempC = lagToward(state.wallTempC, wallTarget, input.dtS, params.wallTauS);
  const tankPressureBar = tankMassKg.map((m) => h2PressureBar(m, params.tankVolumeM3, gasTempC));

  return {
    state: { tankMassKg, gasTempC, wallTempC, valvesOpen, compressorOn: flow.compressorOn, compressor: compressor.state },
    pressureBar: sum(tankPressureBar) / params.tankCount,
    tankPressureBar,
    inKg: flow.inKg,
    outKg: flow.outKg,
    leakKg: sum(tankLeakKg),
    tankLeakKg,
    ventedKg: flow.ventedKg,
    sealLossKg: flow.sealLossKg,
    outflowLimited: flow.outflowLimited,
    compressorKw: compressor.powerKw,
    compressorFlowKgH: (flow.inKg + flow.sealLossKg) / Math.max(dtH, 1e-9),
    dischargeBar,
  };
}
