// PEM 수전해 근사 모델 (순수 함수).
// V_cell = E_rev(T, p) + b·ln(j/j0) + r(T)·j + δ·운전시간, 패러데이 수소, 정류기 부하 의존 효율,
// 최소부하 20%, 기동(냉간·온간)·운전·정지(퍼지)·온간 대기 상태.
import { clamp, lagToward, SECONDS_PER_HOUR } from '../math';
import {
  converterLossKw,
  FARADAY_C_PER_MOL,
  faradayH2KgPerH,
  GAS_CONSTANT_J_PER_MOL_K,
  KELVIN_OFFSET,
  solveIncreasing,
  type ConverterLossModel,
} from './common';

const RECTIFIER_LOSS: ConverterLossModel = { noLoad: 0.006, linear: 0.018, quadratic: 0.012 };
const STANDBY_TEMP_C = 50;

export type ElectrolyzerMode = 'off' | 'standby' | 'starting' | 'running' | 'stopping';

export interface ElectrolyzerParams {
  readonly cellCount: number;
  readonly activeAreaCm2: number;
  readonly ratedCurrentA: number;
  /** 설비 전체(정류기 + 보조설비) 정격 AC [kW] */
  readonly ratedAcKw: number;
  readonly rectifierRatedDcKw: number;
  readonly minLoadFraction: number;
  readonly outletBar: number;
  /** 활성화 과전압 기울기 b [V] (자연로그 기준) */
  readonly tafelSlopeV: number;
  readonly exchangeCurrentAcm2: number;
  readonly ohmicOhmCm2At60C: number;
  /** 수소 크로스오버 등가 전류밀도 → 패러데이 효율 손실 */
  readonly crossoverAcm2: number;
  readonly auxBaseKw: number;
  readonly auxLoadKw: number;
  readonly standbyAuxKw: number;
  readonly offAuxKw: number;
  readonly coldStartS: number;
  readonly warmStartS: number;
  readonly stopS: number;
  readonly standbyHoldS: number;
}

export interface ElectrolyzerState {
  readonly mode: ElectrolyzerMode;
  readonly modeElapsedS: number;
  readonly startDurationS: number;
  readonly stackTempC: number;
  readonly runHours: number;
  readonly starts: number;
  /** 운전시간 열화로 누적된 셀당 전압 상승 [V] */
  readonly degradationV: number;
  readonly h2TotalKg: number;
  readonly energyKwh: number;
}

export interface ElectrolyzerCommand {
  readonly run: boolean;
  /** 설비 전체 AC 전력 목표 [kW] (최소부하 미만이면 최소부하로 운전) */
  readonly acKw: number;
}

export interface ElectrolyzerInput {
  readonly command: ElectrolyzerCommand;
  readonly ambientC: number;
  /** 셀당 전압 열화율 [µV/h] */
  readonly degradationUvPerH: number;
  readonly dtS: number;
}

export interface ElectrolyzerOperatingPoint {
  readonly currentA: number;
  readonly currentDensityAcm2: number;
  readonly cellVoltageV: number;
  readonly stackVoltageV: number;
  readonly dcKw: number;
  readonly rectifierAcKw: number;
  readonly rectifierEfficiency: number;
  readonly auxKw: number;
  readonly totalAcKw: number;
}

export interface ElectrolyzerStep extends ElectrolyzerOperatingPoint {
  readonly state: ElectrolyzerState;
  readonly loadFraction: number;
  readonly faradayEfficiency: number;
  readonly h2KgPerH: number;
  /** 이번 스텝에 제품(저장)으로 보낸 수소 [kg] — 운전 상태에서만 */
  readonly h2ProductKg: number;
  /** 기동 중 순도 미달로 배출한 수소 [kg] */
  readonly h2VentedKg: number;
}

export function electrolyzerParams(stack: {
  cellCount: number;
  activeAreaCm2: number;
  ratedCurrentA: number;
  ratedAcKw: number;
  rectifierRatedDcKw: number;
  outletBar: number;
}): ElectrolyzerParams {
  return {
    ...stack,
    minLoadFraction: 0.2,
    tafelSlopeV: 0.026,
    exchangeCurrentAcm2: 1e-6,
    ohmicOhmCm2At60C: 0.15,
    crossoverAcm2: 0.0015,
    auxBaseKw: 10,
    auxLoadKw: 20,
    standbyAuxKw: 6,
    offAuxKw: 1.5,
    coldStartS: 900,
    warmStartS: 120,
    stopS: 300,
    standbyHoldS: 7_200,
  };
}

/** 가역전압: 1.229 V − 0.9 mV/K 온도 보정 + 음극 가압 Nernst 항 (RT/2F)·ln(p) */
export function reversibleVoltageV(tempC: number, outletBar: number): number {
  const nernst = ((GAS_CONSTANT_J_PER_MOL_K * (tempC + KELVIN_OFFSET)) / (2 * FARADAY_C_PER_MOL)) * Math.log(Math.max(outletBar, 1));
  return 1.229 - 0.0009 * (tempC - 25) + nernst;
}

export function cellVoltageV(params: ElectrolyzerParams, currentDensityAcm2: number, tempC: number, degradationV: number): number {
  const j = Math.max(currentDensityAcm2, params.exchangeCurrentAcm2);
  const activation = params.tafelSlopeV * Math.log(j / params.exchangeCurrentAcm2);
  const ohmic = params.ohmicOhmCm2At60C * (1 + 0.012 * (60 - tempC)) * currentDensityAcm2;
  return reversibleVoltageV(tempC, params.outletBar) + activation + ohmic + degradationV;
}

/** 크로스오버 손실만 반영한 패러데이 효율 (저전류일수록 낮다) */
export function faradayEfficiency(params: ElectrolyzerParams, currentDensityAcm2: number): number {
  if (currentDensityAcm2 <= 0) return 0;
  return clamp(1 - params.crossoverAcm2 / currentDensityAcm2, 0, 1);
}

export function operatingPoint(params: ElectrolyzerParams, currentA: number, tempC: number, degradationV: number): ElectrolyzerOperatingPoint {
  const currentDensityAcm2 = currentA / params.activeAreaCm2;
  if (currentA <= 0) {
    return { currentA: 0, currentDensityAcm2: 0, cellVoltageV: 0, stackVoltageV: 0, dcKw: 0, rectifierAcKw: 0, rectifierEfficiency: 0, auxKw: params.auxBaseKw, totalAcKw: params.auxBaseKw };
  }
  const cell = cellVoltageV(params, currentDensityAcm2, tempC, degradationV);
  const stackVoltageV = cell * params.cellCount;
  const dcKw = (stackVoltageV * currentA) / 1000;
  const rectifierAcKw = dcKw + converterLossKw(RECTIFIER_LOSS, params.rectifierRatedDcKw, dcKw);
  const auxKw = params.auxBaseKw + params.auxLoadKw * (currentA / params.ratedCurrentA);
  return {
    currentA,
    currentDensityAcm2,
    cellVoltageV: cell,
    stackVoltageV,
    dcKw,
    rectifierAcKw,
    rectifierEfficiency: dcKw / rectifierAcKw,
    auxKw,
    totalAcKw: rectifierAcKw + auxKw,
  };
}

/** 설비 AC 목표 → 스택 전류 (정격 전류 상한) */
export function currentForAcPower(params: ElectrolyzerParams, acKw: number, tempC: number, degradationV: number): number {
  return solveIncreasing((currentA) => operatingPoint(params, currentA, tempC, degradationV).totalAcKw, acKw, 0, params.ratedCurrentA);
}

export const electrolyzerMinKw = (params: ElectrolyzerParams): number => params.minLoadFraction * params.ratedAcKw;

function nextMode(params: ElectrolyzerParams, state: ElectrolyzerState, command: ElectrolyzerCommand): ElectrolyzerState {
  const to = (mode: ElectrolyzerMode, extra: Partial<ElectrolyzerState> = {}): ElectrolyzerState => ({ ...state, mode, modeElapsedS: 0, ...extra });
  const startDurationS = state.stackTempC < 40 ? params.coldStartS : params.warmStartS;
  switch (state.mode) {
    case 'off':
    case 'standby':
      if (command.run) return to('starting', { startDurationS, starts: state.starts + 1 });
      return state.mode === 'standby' && state.modeElapsedS >= params.standbyHoldS ? to('off') : state;
    case 'starting':
      if (!command.run) return to('stopping');
      return state.modeElapsedS >= state.startDurationS ? to('running') : state;
    case 'running':
      return command.run ? state : to('stopping');
    case 'stopping':
      return state.modeElapsedS >= params.stopS ? to('standby') : state;
  }
}

function modeCurrentA(params: ElectrolyzerParams, state: ElectrolyzerState, command: ElectrolyzerCommand): number {
  const minKw = electrolyzerMinKw(params);
  if (state.mode === 'running') {
    const targetKw = clamp(command.acKw, minKw, params.ratedAcKw);
    return currentForAcPower(params, targetKw, state.stackTempC, state.degradationV);
  }
  if (state.mode === 'starting') {
    const ramp = clamp((state.modeElapsedS + 1) / Math.max(state.startDurationS, 1), 0.1, 1);
    return currentForAcPower(params, minKw, state.stackTempC, state.degradationV) * ramp;
  }
  return 0;
}

function targetTempC(mode: ElectrolyzerMode, loadFraction: number, ambientC: number): { targetC: number; tauS: number } {
  if (mode === 'running' || mode === 'starting') return { targetC: 55 + 10 * loadFraction, tauS: 900 };
  if (mode === 'off') return { targetC: ambientC, tauS: 10_800 };
  return { targetC: Math.max(STANDBY_TEMP_C, ambientC), tauS: 1_800 };
}

function auxForMode(params: ElectrolyzerParams, mode: ElectrolyzerMode, point: ElectrolyzerOperatingPoint): number {
  if (point.currentA > 0) return point.auxKw;
  if (mode === 'off') return params.offAuxKw;
  return mode === 'stopping' ? params.auxBaseKw : params.standbyAuxKw;
}

export function stepElectrolyzer(params: ElectrolyzerParams, state: ElectrolyzerState, input: ElectrolyzerInput): ElectrolyzerStep {
  const moded = nextMode(params, state, input.command);
  const currentA = modeCurrentA(params, moded, input.command);
  const point = operatingPoint(params, currentA, moded.stackTempC, moded.degradationV);
  const auxKw = auxForMode(params, moded.mode, point);
  const totalAcKw = point.rectifierAcKw + auxKw;
  const loadFraction = currentA / params.ratedCurrentA;
  const etaF = faradayEfficiency(params, point.currentDensityAcm2);
  const h2KgPerH = faradayH2KgPerH(params.cellCount, currentA, etaF);
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const { targetC, tauS } = targetTempC(moded.mode, loadFraction, input.ambientC);
  const energized = currentA > 0;
  const h2ProductKg = moded.mode === 'running' ? h2KgPerH * dtH : 0;

  const nextState: ElectrolyzerState = {
    ...moded,
    modeElapsedS: moded.modeElapsedS + input.dtS,
    stackTempC: lagToward(moded.stackTempC, targetC, input.dtS, tauS),
    runHours: moded.runHours + (energized ? dtH : 0),
    degradationV: moded.degradationV + (energized ? Math.max(0, input.degradationUvPerH) * 1e-6 * dtH : 0),
    h2TotalKg: moded.h2TotalKg + h2ProductKg,
    energyKwh: moded.energyKwh + totalAcKw * dtH,
  };

  return {
    ...point,
    auxKw,
    totalAcKw,
    state: nextState,
    loadFraction,
    faradayEfficiency: etaF,
    h2KgPerH,
    h2ProductKg,
    h2VentedKg: moded.mode === 'starting' ? h2KgPerH * dtH : 0,
  };
}
