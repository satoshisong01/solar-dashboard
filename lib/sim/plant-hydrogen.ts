// 플랜트 조립: PEM 전해조 → 압축기 → 저장뱅크 → PEM 연료전지, 수소 검지기.
import type { SiteDef } from '@/db/seed/types';
import type { HydrogenView, UnitCommand } from './ems';
import { EVENT_CODE, OP_STATE, opStateCode, operationEvent, type SimEvent } from './events';
import {
  electrolyzerMinKw,
  electrolyzerParams,
  stepElectrolyzer,
  type ElectrolyzerMode,
  type ElectrolyzerParams,
  type ElectrolyzerState,
  type ElectrolyzerStep,
} from './models/electrolyzer';
import { fuelCellParams, stepFuelCell, type FuelCellMode, type FuelCellParams, type FuelCellState, type FuelCellStep } from './models/fuelcell';
import { h2MassKg, stepStorage, storageParams, type StorageParams, type StorageState, type StorageStep } from './models/storage';
import { assetsOfClass, nameplateNumber, singleAsset, type InitContext, type ReadingEntry, type StepContext } from './plant-types';
import { DEGRADATION_PARAMS } from './scenarios';

const INITIAL_STORAGE_BAR = 220;
const INITIAL_TEMP_C = 20;
/** 준공 후 누적값 추정: 하루 평균 운전시간 */
const ELZ_HOURS_PER_DAY = 5;
const FC_HOURS_PER_DAY = 4;

export interface HydrogenCodes {
  readonly elz: string;
  readonly stack: string;
  readonly rectifier: string;
  readonly water: string;
  readonly separator: string;
  readonly dryer: string;
  readonly compressor: string;
  readonly bank: string;
  readonly fc: string;
  readonly fcStack: string;
  readonly blower: string;
  readonly cooling: string;
}

export interface HydrogenUnit {
  readonly codes: HydrogenCodes;
  readonly elzParams: ElectrolyzerParams;
  readonly elz: ElectrolyzerStep;
  readonly storageParams: StorageParams;
  readonly storage: StorageStep;
  readonly fcParams: FuelCellParams;
  readonly fc: FuelCellStep;
  readonly tanks: readonly { readonly code: string; readonly pressureOffsetBar: number; readonly tempOffsetC: number }[];
  readonly detectors: readonly { readonly code: string; readonly baselinePpm: number }[];
}

export interface HydrogenStepResult {
  readonly unit: HydrogenUnit;
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
    compressor: code('h2.compressor'),
    bank: code('h2.storage.bank'),
    fc: code('fc.plant'),
    fcStack: code('fc.stack'),
    blower: code('fc.blower'),
    cooling: code('fc.cooling'),
  };
}

function buildParams(site: SiteDef): Pick<HydrogenUnit, 'elzParams' | 'storageParams' | 'fcParams'> {
  const stack = singleAsset(site, 'h2.elz.stack');
  const elz = singleAsset(site, 'h2.elz');
  const bank = singleAsset(site, 'h2.storage.bank');
  const compressor = singleAsset(site, 'h2.compressor');
  const fcStack = singleAsset(site, 'fc.stack');
  return {
    elzParams: electrolyzerParams({
      cellCount: nameplateNumber(stack, 'cell_count'),
      activeAreaCm2: nameplateNumber(stack, 'active_area_cm2'),
      ratedCurrentA: nameplateNumber(stack, 'rated_current_a'),
      ratedAcKw: nameplateNumber(elz, 'rated_kw'),
      rectifierRatedDcKw: nameplateNumber(singleAsset(site, 'h2.elz.rectifier'), 'rated_dc_kw'),
      outletBar: nameplateNumber(elz, 'outlet_bar'),
    }),
    storageParams: storageParams(
      { waterVolumeL: nameplateNumber(bank, 'water_volume_l'), maxBar: nameplateNumber(bank, 'max_bar') },
      { ratedKw: nameplateNumber(compressor, 'rated_kw'), capacityKgH: nameplateNumber(compressor, 'capacity_kg_h') },
    ),
    fcParams: fuelCellParams({
      cellCount: nameplateNumber(fcStack, 'cell_count'),
      activeAreaCm2: nameplateNumber(fcStack, 'active_area_cm2'),
      ratedCurrentA: nameplateNumber(fcStack, 'rated_current_a'),
      ratedAcKw: nameplateNumber(singleAsset(site, 'fc.plant'), 'rated_kw'),
      blowerRatedKw: nameplateNumber(singleAsset(site, 'fc.blower'), 'rated_kw'),
      coolantRatedLpm: nameplateNumber(singleAsset(site, 'fc.cooling'), 'rated_flow_l_min'),
    }),
  };
}

const STOP: UnitCommand = { run: false, acKw: 0 };

export function createHydrogen(init: InitContext): HydrogenUnit | null {
  if (assetsOfClass(init.site, 'h2.elz').length === 0) return null;
  const codes = resolveCodes(init.site);
  const { elzParams, storageParams: sParams, fcParams } = buildParams(init.site);
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
    h2TotalKg: elzHours * 7.5,
    energyKwh: elzHours * 420,
  };
  const storageState: StorageState = {
    massKg: h2MassKg(INITIAL_STORAGE_BAR, sParams.volumeM3, INITIAL_TEMP_C),
    gasTempC: INITIAL_TEMP_C,
    compressorOn: false,
    compressorRunHours: elzHours,
    compressorEnergyKwh: elzHours * 16,
    dischargeTempC: INITIAL_TEMP_C,
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
    storageParams: sParams,
    storage: stepStorage(sParams, storageState, { inflowKgH: 0, outflowKgH: 0, suctionBar: elzParams.outletBar, ambientC: INITIAL_TEMP_C, leakKgPerDay: 0, dtS: 0 }),
    fcParams,
    fc: stepFuelCell(fcParams, fcState, { command: STOP, hydrogenAvailable: true, ambientC: INITIAL_TEMP_C, voltageDecayUvPerH: 0, blowerWear: 0, dtS: 0 }),
    tanks: assetsOfClass(init.site, 'h2.storage.tank').map((a) => ({ code: a.code, pressureOffsetBar: 0.4 * init.rng.gaussian(), tempOffsetC: 0.3 * init.rng.gaussian() })),
    detectors: assetsOfClass(init.site, 'h2.detector').map((a) => ({ code: a.code, baselinePpm: 6 + 6 * init.rng.next() })),
  };
}

export function hydrogenView(unit: HydrogenUnit): HydrogenView {
  return {
    elzMode: unit.elz.state.mode,
    elzRatedKw: unit.elzParams.ratedAcKw,
    elzMinKw: electrolyzerMinKw(unit.elzParams),
    storagePressureBar: unit.storage.pressureBar,
    compressorKw: unit.storage.compressorKw,
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
  if (next.storage.state.compressorOn !== unit.storage.state.compressorOn) {
    const starting = next.storage.state.compressorOn;
    events.push(operationEvent(unit.codes.compressor, tMs, starting ? EVENT_CODE.START : EVENT_CODE.STOP, 'info', starting ? '압축기 기동' : stopText('압축기')));
  }
  const fcBefore = unit.fc.state.mode;
  const fcAfter = next.fc.state.mode;
  if (fcAfter === 'starting' && !FC_ACTIVE.includes(fcBefore)) events.push(operationEvent(unit.codes.fc, tMs, EVENT_CODE.START, 'info', '연료전지 기동'));
  if (fcAfter === 'stopping' && FC_ACTIVE.includes(fcBefore)) events.push(operationEvent(unit.codes.fc, tMs, EVENT_CODE.STOP, 'info', stopText('연료전지')));
  return events;
}

export function stepHydrogen(unit: HydrogenUnit, commands: { readonly elz: UnitCommand; readonly fc: UnitCommand }, ctx: StepContext, lockout: boolean): HydrogenStepResult {
  const { weather, degradation, tMs, dtS } = ctx;
  const elz = stepElectrolyzer(unit.elzParams, unit.elz.state, {
    command: commands.elz,
    ambientC: weather.ambientC,
    degradationUvPerH: degradation.value('elz.degradationUvPerH', unit.codes.stack, tMs),
    dtS,
  });
  const fc = stepFuelCell(unit.fcParams, unit.fc.state, {
    command: commands.fc,
    hydrogenAvailable: unit.storage.pressureBar > unit.storageParams.minBar + 5,
    ambientC: weather.ambientC,
    voltageDecayUvPerH: degradation.value('fc.voltageDecayUvPerH', unit.codes.fcStack, tMs),
    blowerWear: degradation.value('blower.wear', unit.codes.blower, tMs),
    dtS,
  });
  const storage = stepStorage(unit.storageParams, unit.storage.state, {
    inflowKgH: elz.h2ProductKg > 0 ? elz.h2KgPerH : 0,
    outflowKgH: fc.h2KgPerH,
    suctionBar: unit.elzParams.outletBar,
    ambientC: weather.ambientC,
    leakKgPerDay: degradation.value('storage.leakKgPerDay', unit.codes.bank, tMs),
    dtS,
  });
  const next: HydrogenUnit = { ...unit, elz, fc, storage };
  return {
    unit: next,
    events: transitionEvents(unit, next, tMs, lockout),
    elzAcKw: elz.totalAcKw,
    fcAcKw: fc.acKw,
    compressorKw: storage.compressorKw,
  };
}

const sawtooth = (value: number, period: number): number => (value % period) / period;
const wave = (tMs: number, periodS: number, phase = 0): number => Math.sin((2 * Math.PI * tMs) / (periodS * 1000) + phase);

function electrolyzerReadings(unit: HydrogenUnit, ctx: StepContext): ReadingEntry[] {
  const { elz, codes, elzParams } = unit;
  const { mode } = elz.state;
  const load = elz.loadFraction;
  const active = ELZ_ACTIVE.includes(mode);
  const pressurized = mode !== 'off';
  const cell = elz.cellVoltageV;
  return [
    [codes.elz, {
      'ac.power': elz.totalAcKw,
      'ac.energy.total': elz.state.energyKwh,
      'h2.flow.mass': mode === 'running' ? elz.h2KgPerH : 0,
      'h2.mass.total': elz.state.h2TotalKg,
      'h2.pressure': pressurized ? elzParams.outletBar : 1.2,
      'h2.in.o2': active ? 0.12 + 0.1 / Math.max(load, 0.1) : 0,
      'o2.in.h2': active ? 40 + 60 / Math.max(load, 0.1) : 0,
      'op.state': opStateCode(mode),
      'start.count': elz.state.starts,
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
      'heatsink.temp': ctx.weather.ambientC + 6 + 30 * load,
    }],
    [codes.water, {
      'water.conductivity#product': 0.07,
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

function storageReadings(unit: HydrogenUnit, extraPpm: (detectorCode: string) => number): ReadingEntry[] {
  const { storage, codes } = unit;
  const on = storage.state.compressorOn;
  return [
    [codes.compressor, {
      'compressor.power': storage.compressorKw,
      'compressor.suction.pressure': unit.elz.state.mode !== 'off' ? unit.elzParams.outletBar : 1.2,
      'compressor.discharge.pressure': storage.dischargeBar,
      'compressor.discharge.temp': storage.state.dischargeTempC,
      'compressor.leak.pressure': 0.05,
      'ac.energy.total': storage.state.compressorEnergyKwh,
      'run.hours': storage.state.compressorRunHours,
      'op.state': on ? OP_STATE.RUNNING : OP_STATE.STANDBY,
      'vibration.rms': on ? 1.8 : 0.2,
    }],
    [codes.bank, {
      'h2.inventory': storage.state.massKg,
      'valve.open#inlet': on ? 1 : 0,
      'valve.open#outlet': unit.fc.currentA > 0 ? 1 : 0,
    }],
    ...unit.tanks.map((tank): ReadingEntry => [tank.code, {
      'tank.pressure': Math.max(0, storage.pressureBar + tank.pressureOffsetBar),
      'tank.temp': storage.state.gasTempC + tank.tempOffsetC,
    }]),
    ...unit.detectors.map((d): ReadingEntry => [d.code, { 'gas.detector.ppm': d.baselinePpm + extraPpm(d.code) }]),
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
      'h2.pressure': fc.currentA > 0 ? Math.min(8, unit.storage.pressureBar) : 0.5,
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
  return [...electrolyzerReadings(unit, ctx), ...storageReadings(unit, extraPpm), ...fuelCellReadings(unit)];
}
