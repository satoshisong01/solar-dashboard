// PEM 연료전지(순수소) 근사 모델 (순수 함수).
// 분극곡선 V = OCV − 활성화 − 저항 − 농도손실 − 운전시간 감쇠, 패러데이 수소 소비, 블로워 P ∝ Q³/효율(마모),
// 냉각수 입출구 온도, 애노드 퍼지 카운트, 기동·정지.
import { clamp, lagToward, SECONDS_PER_HOUR } from '../math';
import {
  FARADAY_C_PER_MOL,
  faradayH2KgPerH,
  O2_MASS_FRACTION_IN_AIR,
  O2_MOLAR_MASS_KG_PER_MOL,
  solveIncreasing,
} from './common';

/** 열중립 전압(HHV) — 셀당 발열 = I × (1.254 − V_cell) */
const THERMONEUTRAL_V = 1.254;
const COOLANT_CP_KJ_PER_KG_K = 3.6; // 글리콜 혼합 냉각수
const COOLANT_DENSITY_KG_PER_L = 1.03;
/** 발열 중 냉각수로 빠지는 비율 (나머지는 배기·복사) */
const COOLANT_HEAT_SHARE = 0.7;

export type FuelCellMode = 'off' | 'starting' | 'running' | 'stopping';

export interface FuelCellParams {
  readonly cellCount: number;
  readonly activeAreaCm2: number;
  readonly ratedCurrentA: number;
  readonly ratedAcKw: number;
  readonly minLoadFraction: number;
  readonly openCircuitV: number;
  readonly tafelSlopeV: number;
  readonly exchangeCurrentAcm2: number;
  readonly ohmicOhmCm2: number;
  readonly limitingCurrentAcm2: number;
  readonly concentrationCoefV: number;
  readonly inverterEfficiency: number;
  readonly bopKw: number;
  readonly blowerRatedKw: number;
  readonly blowerBaseKw: number;
  readonly airStoich: number;
  readonly minAirFraction: number;
  /** 퍼지 손실을 반영한 수소 이용률 */
  readonly hydrogenUtilization: number;
  /** 이 전하량 [A·s]마다 애노드 퍼지 1회 */
  readonly purgeChargeAs: number;
  readonly coolantRatedLpm: number;
  readonly coolantSetpointC: number;
  readonly startS: number;
  readonly stopS: number;
}

export interface FuelCellState {
  readonly mode: FuelCellMode;
  readonly modeElapsedS: number;
  readonly stackTempC: number;
  readonly runHours: number;
  readonly starts: number;
  readonly purges: number;
  readonly purgeChargeAs: number;
  /** 운전시간 감쇠로 누적된 셀당 전압 손실 [V] */
  readonly decayV: number;
  readonly energyKwh: number;
}

export interface FuelCellCommand {
  readonly run: boolean;
  /** 순 AC 출력 목표 [kW] */
  readonly acKw: number;
}

export interface FuelCellInput {
  readonly command: FuelCellCommand;
  readonly hydrogenAvailable: boolean;
  readonly ambientC: number;
  /** 셀당 전압 감쇠율 [µV/h] */
  readonly voltageDecayUvPerH: number;
  /** 블로워 마모 (0 = 신품, 0.2 = 같은 유량에 전력 1/(1−0.2)배) */
  readonly blowerWear: number;
  readonly dtS: number;
}

export interface FuelCellStep {
  readonly state: FuelCellState;
  readonly currentA: number;
  readonly currentDensityAcm2: number;
  readonly cellVoltageV: number;
  readonly stackVoltageV: number;
  readonly dcKw: number;
  readonly acKw: number;
  readonly blowerKw: number;
  readonly airFlowKgH: number;
  readonly h2KgPerH: number;
  readonly h2ConsumedKg: number;
  readonly coolantFlowLpm: number;
  readonly coolantInC: number;
  readonly coolantOutC: number;
  readonly loadFraction: number;
}

export function fuelCellParams(stack: { cellCount: number; activeAreaCm2: number; ratedCurrentA: number; ratedAcKw: number; blowerRatedKw: number; coolantRatedLpm: number }): FuelCellParams {
  return {
    ...stack,
    minLoadFraction: 0.1,
    openCircuitV: 1.0,
    tafelSlopeV: 0.03,
    exchangeCurrentAcm2: 0.001,
    ohmicOhmCm2: 0.08,
    limitingCurrentAcm2: 1.6,
    concentrationCoefV: 0.05,
    inverterEfficiency: 0.96,
    bopKw: 2,
    blowerBaseKw: 0.3,
    airStoich: 2,
    minAirFraction: 0.15,
    hydrogenUtilization: 0.98,
    purgeChargeAs: stack.ratedCurrentA * 45,
    coolantSetpointC: 60,
    startS: 300,
    stopS: 180,
  };
}

/** 셀 전압 [V] = OCV − b·ln(j/j0) − r·j − c·ln(1 − j/j_lim) − 감쇠 */
export function polarizationCellVoltageV(params: FuelCellParams, currentDensityAcm2: number, decayV: number): number {
  const j = Math.max(0, currentDensityAcm2);
  const activation = j > params.exchangeCurrentAcm2 ? params.tafelSlopeV * Math.log(j / params.exchangeCurrentAcm2) : 0;
  const ohmic = params.ohmicOhmCm2 * j;
  const concentration = -params.concentrationCoefV * Math.log(1 - Math.min(j / params.limitingCurrentAcm2, 0.99));
  return params.openCircuitV - activation - ohmic - concentration - decayV;
}

/** 공기 질량유량 [kg/h]: 산소 소비 N·I/(4F) × 공기비 λ, 저부하 최소 유량 보장 */
export function airFlowKgH(params: FuelCellParams, currentA: number): number {
  const stoichFlow = (I: number) =>
    ((params.cellCount * I) / (4 * FARADAY_C_PER_MOL)) * O2_MOLAR_MASS_KG_PER_MOL / O2_MASS_FRACTION_IN_AIR * params.airStoich * SECONDS_PER_HOUR;
  if (currentA <= 0) return 0;
  return Math.max(stoichFlow(currentA), params.minAirFraction * stoichFlow(params.ratedCurrentA));
}

/** 블로워 전력 [kW] = 기저 + 정격 × (Q/Q_rated)³ / (1 − 마모) */
export function blowerPowerKw(params: FuelCellParams, flowKgH: number, wear: number): number {
  if (flowKgH <= 0) return 0;
  const ratedFlow = airFlowKgH(params, params.ratedCurrentA);
  const efficiencyFactor = 1 - clamp(wear, 0, 0.9);
  return params.blowerBaseKw + ((params.blowerRatedKw * 0.7 * (flowKgH / ratedFlow) ** 3) / efficiencyFactor);
}

interface FuelCellPoint {
  readonly cellVoltageV: number;
  readonly stackVoltageV: number;
  readonly dcKw: number;
  readonly airFlowKgH: number;
  readonly blowerKw: number;
  readonly acKw: number;
}

function pointAt(params: FuelCellParams, currentA: number, decayV: number, wear: number): FuelCellPoint {
  const cell = polarizationCellVoltageV(params, currentA / params.activeAreaCm2, decayV);
  const stackVoltageV = cell * params.cellCount;
  const dcKw = (stackVoltageV * Math.max(0, currentA)) / 1000;
  const flow = airFlowKgH(params, currentA);
  const blowerKw = blowerPowerKw(params, flow, wear);
  const acKw = currentA > 0 ? dcKw * params.inverterEfficiency - blowerKw - params.bopKw : 0;
  return { cellVoltageV: cell, stackVoltageV, dcKw, airFlowKgH: flow, blowerKw, acKw };
}

function nextMode(params: FuelCellParams, state: FuelCellState, input: FuelCellInput): FuelCellState {
  const wantsRun = input.command.run && input.hydrogenAvailable;
  const to = (mode: FuelCellMode, extra: Partial<FuelCellState> = {}): FuelCellState => ({ ...state, mode, modeElapsedS: 0, ...extra });
  switch (state.mode) {
    case 'off':
      return wantsRun ? to('starting', { starts: state.starts + 1 }) : state;
    case 'starting':
      if (!wantsRun) return to('stopping');
      return state.modeElapsedS >= params.startS ? to('running') : state;
    case 'running':
      return wantsRun ? state : to('stopping');
    case 'stopping':
      return state.modeElapsedS >= params.stopS ? to('off') : state;
  }
}

function modeCurrentA(params: FuelCellParams, state: FuelCellState, input: FuelCellInput): number {
  const solveFor = (acKw: number) =>
    solveIncreasing((I) => pointAt(params, I, state.decayV, input.blowerWear).acKw, acKw, 1, params.ratedCurrentA);
  const minKw = params.minLoadFraction * params.ratedAcKw;
  if (state.mode === 'running') return solveFor(clamp(input.command.acKw, minKw, params.ratedAcKw));
  if (state.mode === 'starting') return solveFor(minKw) * clamp((state.modeElapsedS + 1) / params.startS, 0.1, 1);
  return 0;
}

export function stepFuelCell(params: FuelCellParams, state: FuelCellState, input: FuelCellInput): FuelCellStep {
  const moded = nextMode(params, state, input);
  const currentA = modeCurrentA(params, moded, input);
  const point = pointAt(params, currentA, moded.decayV, input.blowerWear);
  const dtH = input.dtS / SECONDS_PER_HOUR;
  const loadFraction = currentA / params.ratedCurrentA;
  const h2KgPerH = faradayH2KgPerH(params.cellCount, currentA) / params.hydrogenUtilization;

  const energized = currentA > 0;
  const coolantFlowLpm = energized ? params.coolantRatedLpm * (0.35 + 0.65 * loadFraction) : 0;
  const heatKw = energized ? (params.cellCount * currentA * Math.max(0, THERMONEUTRAL_V - point.cellVoltageV)) / 1000 : 0;
  const coolantKgPerS = (coolantFlowLpm / 60) * COOLANT_DENSITY_KG_PER_L;
  const deltaC = coolantKgPerS > 0 ? (COOLANT_HEAT_SHARE * heatKw) / (coolantKgPerS * COOLANT_CP_KJ_PER_KG_K) : 0;
  const stackTargetC = energized ? params.coolantSetpointC + deltaC : input.ambientC;
  const stackTempC = lagToward(moded.stackTempC, stackTargetC, input.dtS, energized ? 300 : 5_400);
  const purgeCharge = moded.purgeChargeAs + currentA * input.dtS;
  const newPurges = Math.floor(purgeCharge / params.purgeChargeAs);
  const acKw = energized ? point.acKw : -params.bopKw * (moded.mode === 'off' ? 0.25 : 1);

  return {
    state: {
      ...moded,
      modeElapsedS: moded.modeElapsedS + input.dtS,
      stackTempC,
      runHours: moded.runHours + (energized ? dtH : 0),
      purges: moded.purges + newPurges,
      purgeChargeAs: purgeCharge - newPurges * params.purgeChargeAs,
      decayV: moded.decayV + (energized ? Math.max(0, input.voltageDecayUvPerH) * 1e-6 * dtH : 0),
      energyKwh: moded.energyKwh + Math.max(0, acKw) * dtH,
    },
    currentA,
    currentDensityAcm2: currentA / params.activeAreaCm2,
    cellVoltageV: energized ? point.cellVoltageV : 0,
    stackVoltageV: energized ? point.stackVoltageV : 0,
    dcKw: point.dcKw,
    acKw,
    blowerKw: point.blowerKw,
    airFlowKgH: point.airFlowKgH,
    h2KgPerH,
    h2ConsumedKg: h2KgPerH * dtH,
    coolantFlowLpm,
    coolantInC: stackTempC - (energized ? deltaC : 0),
    coolantOutC: stackTempC,
    loadFraction,
  };
}
