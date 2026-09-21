// 플랜트 조립: PEM 전해조 → (건조기) → 압축기·저장뱅크(plant-storage) → PEM 연료전지, 수소 검지기.
// 수소 흐름: 저장 유입 = 전해조 제품(운전 중) × (1 − 건조기 재생 손실). 기동 중 순도 미달 수소는 배출한다.
// 전해조 유량계(h2.flow.mass·h2.mass.total)는 건조기 뒤 제품 배관에 있다(유량계 드리프트 고장은 계량값만 바꾼다).
import type { SiteDef } from '@/db/seed/types';
import { DEGRADATION_PARAMS } from './degradation';
import type { HydrogenView, UnitCommand } from './ems';
import { EVENT_CODE, opStateCode, operationEvent, type SimEvent } from './events';
import {
  electrolyzerMinKw,
  NO_ELZ_FAULTS,
  stepElectrolyzer,
  type ElectrolyzerFaults,
  type ElectrolyzerMode,
  type ElectrolyzerParams,
  type ElectrolyzerState,
  type ElectrolyzerStep,
} from './models/electrolyzer';
import { fuelCellParams, stepFuelCell, type FuelCellMode, type FuelCellParams, type FuelCellState, type FuelCellStep } from './models/fuelcell';
import { createStorage, stepStorageUnit, storageReadings, type StorageUnit } from './plant-storage';
import { assetsOfClass, nameplateNumber, singleAsset, type InitContext, type ReadingEntry, type StepContext } from './plant-types';
import { electrolyzerParamsOf } from './site-params';

const INITIAL_TEMP_C = 20;
/** 준공 후 누적값 추정: 하루 평균 운전시간 */
const ELZ_HOURS_PER_DAY = 5;
const FC_HOURS_PER_DAY = 4;
/** TSA 건조기 재생 손실: 운전 중 제품 수소의 3% (재생 퍼지 2~5% 범위의 추정값) */
export const DRYER_LOSS_FRACTION = 0.03;
/**
 * 퍼지(건조기 재생) 빈도가 오르면 재생 1회당 손실은 그대로라 손실률이 같은 비율로 커진다.
 * 같은 전력에 제품 수소가 줄어 비에너지가 오르고, 퍼지 카운터도 같은 비율로 빨리 오른다 (el.sec_rise 퍼지 경로).
 */
const dryerLossFraction = (faults: ElectrolyzerFaults): number => Math.min(0.5, DRYER_LOSS_FRACTION * (1 + Math.max(0, faults.purgeRateExtra)));

export interface HydrogenCodes {
  readonly elz: string;
  readonly stack: string;
  readonly rectifier: string;
  readonly water: string;
  readonly separator: string;
  readonly dryer: string;
  readonly fc: string;
  readonly fcStack: string;
  readonly blower: string;
  readonly cooling: string;
}

export interface HydrogenMeter {
  /** 유량계 적산값 [kg] */
  readonly totalKg: number;
  /** 이번 스텝 유량계 이득 */
  readonly gain: number;
}

export interface HydrogenUnit {
  readonly codes: HydrogenCodes;
  readonly elzParams: ElectrolyzerParams;
  readonly elz: ElectrolyzerStep;
  /** 이번 스텝에 적용한 전해조 비에너지 고장 (측정값 계산용) */
  readonly elzFaults: ElectrolyzerFaults;
  readonly meter: HydrogenMeter;
  readonly storage: StorageUnit;
  readonly fcParams: FuelCellParams;
  readonly fc: FuelCellStep;
}

export interface HydrogenStepResult {
  readonly unit: HydrogenUnit;
  /** 이번 스텝에 버퍼로 실제 들어간 반입량 [kg] (용기 여유가 없으면 요청보다 적다) */
  readonly deliveredKg: number;
  readonly events: readonly SimEvent[];
  readonly elzAcKw: number;
  readonly fcAcKw: number;
  readonly compressorKw: number;
}

function resolveCodes(site: SiteDef): HydrogenCodes {
  const code = (classKey: string) => singleAsset(site, classKey).code;
  return {
    elz: code('h2.elz'),
    stack: code('h2.elz.stack'),
    rectifier: code('h2.elz.rectifier'),
    water: code('h2.elz.water'),
    separator: code('h2.elz.gls'),
    dryer: code('h2.elz.dryer'),
    fc: code('fc.plant'),
    fcStack: code('fc.stack'),
    blower: code('fc.blower'),
    cooling: code('fc.cooling'),
  };
}

function fuelCellParamsOf(site: SiteDef): FuelCellParams {
  const fcStack = singleAsset(site, 'fc.stack');
  return fuelCellParams({
    cellCount: nameplateNumber(fcStack, 'cell_count'),
    activeAreaCm2: nameplateNumber(fcStack, 'active_area_cm2'),
    ratedCurrentA: nameplateNumber(fcStack, 'rated_current_a'),
    ratedAcKw: nameplateNumber(singleAsset(site, 'fc.plant'), 'rated_kw'),
    blowerRatedKw: nameplateNumber(singleAsset(site, 'fc.blower'), 'rated_kw'),
    coolantRatedLpm: nameplateNumber(singleAsset(site, 'fc.cooling'), 'rated_flow_l_min'),
  });
}

const STOP: UnitCommand = { run: false, acKw: 0 };

export function createHydrogen(init: InitContext): HydrogenUnit | null {
  if (assetsOfClass(init.site, 'h2.elz').length === 0) return null;
  const codes = resolveCodes(init.site);
  const elzParams = electrolyzerParamsOf(init.site);
  const fcParams = fuelCellParamsOf(init.site);
  const elzHours = init.daysInService * ELZ_HOURS_PER_DAY;
  const fcHours = init.daysInService * FC_HOURS_PER_DAY;
  const elzState: ElectrolyzerState = {
    mode: 'off',
    modeElapsedS: 0,
    startDurationS: elzParams.coldStartS,
    stackTempC: INITIAL_TEMP_C,
    runHours: elzHours,
    starts: Math.round(init.daysInService),
    degradationV: DEGRADATION_PARAMS['elz.degradationUvPerH'].baseline * 1e-6 * elzHours, // 시작 전 이력은 기본값으로 추정
    purges: Math.round(elzHours * 6), // 정격 근처 운전 기준 시간당 6회 [가정]
    purgeChargeAs: 0,
    h2TotalKg: elzHours * 7.5,
    energyKwh: elzHours * 420,
  };
  const fcState: FuelCellState = {
    mode: 'off',
    modeElapsedS: 0,
    stackTempC: INITIAL_TEMP_C,
    runHours: fcHours,
    starts: Math.round(init.daysInService),
    purges: Math.round(fcHours * 70),
    purgeChargeAs: 0,
    decayV: DEGRADATION_PARAMS['fc.voltageDecayUvPerH'].baseline * 1e-6 * fcHours,
    energyKwh: fcHours * 150,
  };
  return {
    codes,
    elzParams,
    elz: stepElectrolyzer(elzParams, elzState, { command: STOP, ambientC: INITIAL_TEMP_C, degradationUvPerH: 0, dtS: 0 }),
    elzFaults: NO_ELZ_FAULTS,
    meter: { totalKg: elzState.h2TotalKg * (1 - DRYER_LOSS_FRACTION), gain: 1 },
    storage: createStorage(init, elzHours, elzParams.outletBar),
    fcParams,
    fc: stepFuelCell(fcParams, fcState, { command: STOP, hydrogenAvailable: true, ambientC: INITIAL_TEMP_C, voltageDecayUvPerH: 0, blowerWear: 0, dtS: 0 }),
  };
}

export function hydrogenView(unit: HydrogenUnit): HydrogenView {
  return {
    elzMode: unit.elz.state.mode,
    elzRatedKw: unit.elzParams.ratedAcKw,
    elzMinKw: electrolyzerMinKw(unit.elzParams),
    storagePressureBar: unit.storage.step.pressureBar,
    storageMaxBar: unit.storage.params.maxBar,
    fcRatedKw: unit.fcParams.ratedAcKw,
    compressorKw: unit.storage.step.compressorKw,
  };
}

const ELZ_ACTIVE: readonly ElectrolyzerMode[] = ['starting', 'running'];
const FC_ACTIVE: readonly FuelCellMode[] = ['starting', 'running'];

function transitionEvents(unit: HydrogenUnit, next: HydrogenUnit, tMs: number, lockout: boolean): SimEvent[] {
  const stopText = (name: string) => (lockout ? `${name} 정지 (안전 인터록)` : `${name} 정지`);
  const events: SimEvent[] = [];
  const elzBefore = unit.elz.state.mode;
  const elzAfter = next.elz.state.mode;
  if (elzAfter === 'starting' && !ELZ_ACTIVE.includes(elzBefore)) events.push(operationEvent(unit.codes.elz, tMs, EVENT_CODE.START, 'info', '수전해 기동'));
  if (elzAfter === 'stopping' && ELZ_ACTIVE.includes(elzBefore)) events.push(operationEvent(unit.codes.elz, tMs, EVENT_CODE.STOP, 'info', stopText('수전해')));
  const compressorOn = next.storage.step.state.compressorOn;
  if (compressorOn !== unit.storage.step.state.compressorOn) {
    events.push(operationEvent(next.storage.compressorCode, tMs, compressorOn ? EVENT_CODE.START : EVENT_CODE.STOP, 'info', compressorOn ? '압축기 기동' : stopText('압축기')));
  }
  const fcBefore = unit.fc.state.mode;
  const fcAfter = next.fc.state.mode;
  if (fcAfter === 'starting' && !FC_ACTIVE.includes(fcBefore)) events.push(operationEvent(unit.codes.fc, tMs, EVENT_CODE.START, 'info', '연료전지 기동'));
  if (fcAfter === 'stopping' && FC_ACTIVE.includes(fcBefore)) events.push(operationEvent(unit.codes.fc, tMs, EVENT_CODE.STOP, 'info', stopText('연료전지')));
  return events;
}

function electrolyzerFaultsAt(unit: HydrogenUnit, ctx: StepContext): ElectrolyzerFaults {
  const { degradation, tMs } = ctx;
  return {
    rectifierLossExtra: degradation.value('elz.rectifierLossExtra', unit.codes.rectifier, tMs),
    faradaicLoss: degradation.value('elz.faradaicLoss', unit.codes.stack, tMs),
    extraCellVoltageV: degradation.value('elz.extraCellVoltageV', unit.codes.stack, tMs),
    purgeRateExtra: degradation.value('elz.purgeRateExtra', unit.codes.dryer, tMs),
  };
}

/** 압축기 흡입 압력: 대조군(높은 압력비 운전)이 낮추지 않으면 전해조 출구 압력 */
const suctionBarOf = (unit: HydrogenUnit, ctx: StepContext): number => ctx.p3.suctionBar ?? unit.elzParams.outletBar;

export function stepHydrogen(unit: HydrogenUnit, commands: { readonly elz: UnitCommand; readonly fc: UnitCommand }, ctx: StepContext, lockout: boolean, deliveryKgH = 0): HydrogenStepResult {
  const { weather, degradation, tMs, dtS } = ctx;
  const elzFaults = electrolyzerFaultsAt(unit, ctx);
  const elz = stepElectrolyzer(unit.elzParams, unit.elz.state, {
    command: commands.elz,
    ambientC: weather.ambientC,
    degradationUvPerH: degradation.value('elz.degradationUvPerH', unit.codes.stack, tMs),
    dtS,
    faults: elzFaults,
  });
  const fc = stepFuelCell(unit.fcParams, unit.fc.state, {
    command: commands.fc,
    hydrogenAvailable: unit.storage.step.pressureBar > unit.storage.params.minBar + 5,
    ambientC: weather.ambientC,
    voltageDecayUvPerH: degradation.value('fc.voltageDecayUvPerH', unit.codes.fcStack, tMs),
    blowerWear: degradation.value('blower.wear', unit.codes.blower, tMs),
    blowerFilterClog: degradation.value('blower.filterClog', unit.codes.blower, tMs),
    dtS,
  });
  const dryerLoss = dryerLossFraction(elzFaults);
  const productKgH = elz.h2ProductKg > 0 ? elz.h2KgPerH * (1 - dryerLoss) : 0;
  const storage = stepStorageUnit(unit.storage, { inflowKgH: productKgH, directInflowKgH: deliveryKgH, outflowKgH: fc.h2KgPerH, suctionBar: suctionBarOf(unit, ctx) }, ctx);
  const gain = degradation.value('meter.h2FlowGain', unit.codes.elz, tMs);
  const meter: HydrogenMeter = { totalKg: unit.meter.totalKg + elz.h2ProductKg * (1 - dryerLoss) * gain, gain };
  const next: HydrogenUnit = { ...unit, elz, elzFaults, meter, fc, storage };
  return {
    unit: next,
    deliveredKg: storage.step.directInKg,
    events: transitionEvents(unit, next, tMs, lockout),
    elzAcKw: elz.totalAcKw,
    fcAcKw: fc.acKw,
    compressorKw: storage.step.compressorKw,
  };
}

const sawtooth = (value: number, period: number): number => (value % period) / period;
const wave = (tMs: number, periodS: number, phase = 0): number => Math.sin((2 * Math.PI * tMs) / (periodS * 1000) + phase);
/** 정류기 추가 손실 1 kW당 방열판 온도 상승 [°C] */
const RECTIFIER_EXTRA_LOSS_C_PER_KW = 0.4;
/** 패러데이 효율 추가 손실(크로스오버 증가)에 따른 수소 중 산소 농도 배율 계수 */
const HTO_PER_FARADAIC_LOSS = 8;

function electrolyzerReadings(unit: HydrogenUnit, ctx: StepContext): ReadingEntry[] {
  const { elz, codes, elzParams } = unit;
  const { mode } = elz.state;
  const load = elz.loadFraction;
  const active = ELZ_ACTIVE.includes(mode);
  const pressurized = mode !== 'off';
  const cell = elz.cellVoltageV;
  const dryerLoss = dryerLossFraction(unit.elzFaults);
  return [
    [codes.elz, {
      'ac.power': elz.totalAcKw,
      'ac.energy.total': elz.state.energyKwh,
      'h2.flow.mass': mode === 'running' ? elz.h2KgPerH * (1 - dryerLoss) * unit.meter.gain : 0,
      'h2.mass.total': unit.meter.totalKg,
      'h2.pressure': pressurized ? elzParams.outletBar : 1.2,
      'h2.in.o2': active ? (0.12 + 0.1 / Math.max(load, 0.1)) * (1 + HTO_PER_FARADAIC_LOSS * unit.elzFaults.faradaicLoss) : 0,
      'o2.in.h2': active ? 40 + 60 / Math.max(load, 0.1) : 0,
      'op.state': opStateCode(mode),
      'start.count': elz.state.starts,
      'purge.count': elz.state.purges,
    }],
    [codes.stack, {
      'stack.voltage': elz.stackVoltageV,
      'stack.current': elz.currentA,
      'stack.temp': elz.state.stackTempC,
      'stack.temp.in': elz.state.stackTempC - (active ? 5 * load : 0),
      'stack.pressure.diff': pressurized ? elzParams.outletBar - 1 : 0,
      'cell.voltage.max': cell > 0 ? cell + 0.006 + 0.004 * load : 0,
      'cell.voltage.min': cell > 0 ? cell - 0.008 - 0.003 * load : 0,
      'cell.voltage.avg': cell,
      'run.hours': elz.state.runHours,
    }],
    [codes.rectifier, {
      'ac.power': elz.rectifierAcKw,
      'dc.power': elz.dcKw,
      'ac.pf': elz.dcKw > 0 ? 0.9 + 0.08 * load : 0,
      'rectifier.efficiency': elz.rectifierEfficiency * 100,
      'heatsink.temp': ctx.weather.ambientC + 6 + 30 * load + RECTIFIER_EXTRA_LOSS_C_PER_KW * elz.rectifierExtraLossKw,
    }],
    [codes.water, {
      'water.conductivity#product': 0.07 + ctx.degradation.value('water.conductivityRise', codes.water, ctx.tMs),
      'water.conductivity#loop': 0.25 + 0.5 * sawtooth(elz.state.runHours, 2_000),
      'water.flow': active ? 6.5 * (0.5 + 0.5 * load) : pressurized ? 2 : 0,
    }],
    [codes.separator, {
      'separator.level#h2': active ? 50 + 3 * wave(ctx.tMs, 420) : 45,
      'separator.level#o2': active ? 50 + 3 * wave(ctx.tMs, 540, 1) : 45,
    }],
    [codes.dryer, {
      'h2.purity': mode === 'running' ? 99.995 - 0.003 * (1 - load) : 99.99,
      'h2.dewpoint': mode === 'running' ? -72 + 3 * (1 - load) : -65,
    }],
  ];
}

function fuelCellReadings(unit: HydrogenUnit): ReadingEntry[] {
  const { fc, codes } = unit;
  const load = fc.loadFraction;
  const cell = fc.cellVoltageV;
  return [
    [codes.fc, {
      'fc.ac.power': fc.acKw,
      'fc.h2.consumption': fc.h2KgPerH,
      'h2.pressure': fc.currentA > 0 ? Math.min(8, unit.storage.step.pressureBar) : 0.5,
      'purge.count': fc.state.purges,
      'start.count': fc.state.starts,
      'op.state': opStateCode(fc.state.mode),
    }],
    [codes.fcStack, {
      'stack.voltage': fc.stackVoltageV,
      'stack.current': fc.currentA,
      'stack.temp': fc.state.stackTempC,
      'cell.voltage.min': cell > 0 ? cell - 0.012 - 0.01 * load : 0,
      'cell.voltage.avg': cell,
      'run.hours': fc.state.runHours,
    }],
    [codes.blower, { 'blower.power': fc.blowerKw, 'blower.flow': fc.airFlowKgH }],
    [codes.cooling, {
      'fc.coolant.temp.in': fc.coolantInC,
      'fc.coolant.temp.out': fc.coolantOutC,
      'fc.coolant.flow': fc.coolantFlowLpm,
      'water.conductivity': 1.1 + 0.3 * sawtooth(fc.state.runHours, 1_500),
    }],
  ];
}

export function hydrogenReadings(unit: HydrogenUnit, ctx: StepContext, extraPpm: (detectorCode: string) => number): readonly ReadingEntry[] {
  const storageView = { elzPressurized: unit.elz.state.mode !== 'off', suctionBar: suctionBarOf(unit, ctx), fcDrawing: unit.fc.currentA > 0 };
  return [...electrolyzerReadings(unit, ctx), ...storageReadings(unit.storage, storageView, extraPpm), ...fuelCellReadings(unit)];
}
