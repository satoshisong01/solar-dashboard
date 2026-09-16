// 플랜트 조립: 수소 압축기 + 저장뱅크(용기 N개) + 수소 검지기 — 상태 전진과 측정값.
import type { SiteDef } from '@/db/seed/types';
import { OP_STATE } from './events';
import { plcH2MassKg } from './models/h2-eos';
import { initialStorageState, stepStorage, storageParams, type StorageParams, type StorageStep } from './models/storage';
import { assetsOfClass, nameplateNumber, singleAsset, sumOf, type InitContext, type ReadingEntry, type StepContext } from './plant-types';

const INITIAL_STORAGE_BAR = 220;
const INITIAL_TEMP_C = 20;
/** 용기 주변 온도 일사 가열: 수평면 일사 1000 W/m²당 +6 °C (옥외 강재 용기, 추정) */
const TANK_SOLAR_GAIN_C = 6;
/** 전해조 출구가 대기압일 때 압축기 흡입 압력 표시값 [bar] */
const SUCTION_IDLE_BAR = 1.2;

export interface TankUnit {
  readonly code: string;
  /** 압력 전송기 고정 교정 오프셋 [bar] */
  readonly pressureOffsetBar: number;
  /** 온도 센서 고정 교정 오프셋 [°C] */
  readonly tempOffsetC: number;
}

export interface StorageUnit {
  readonly bankCode: string;
  readonly compressorCode: string;
  readonly params: StorageParams;
  readonly step: StorageStep;
  readonly tanks: readonly TankUnit[];
  readonly detectors: readonly { readonly code: string; readonly baselinePpm: number }[];
}

export interface StorageFlows {
  /** 저장뱅크로 보내는 전해조 제품 수소 [kg/h] */
  readonly inflowKgH: number;
  /** 연료전지 수요 [kg/h] */
  readonly outflowKgH: number;
  /** 외부 반입 하역 유량 [kg/h] (압축기를 거치지 않고 버퍼로 바로 들어간다) */
  readonly directInflowKgH?: number;
  readonly suctionBar: number;
}

function buildParams(site: SiteDef, tankCount: number): StorageParams {
  const compressor = singleAsset(site, 'h2.compressor');
  const tank = assetsOfClass(site, 'h2.storage.tank')[0];
  if (!tank) throw new Error(`${site.code}에 h2.storage.tank 설비가 없습니다`);
  const bank = singleAsset(site, 'h2.storage.bank');
  const minOutletBar = bank.nameplate.min_outlet_bar;
  return storageParams(
    { tankCount, tankWaterVolumeL: nameplateNumber(tank, 'water_volume_l'), maxBar: nameplateNumber(tank, 'max_bar'), minBar: typeof minOutletBar === 'number' ? minOutletBar : undefined },
    { ratedKw: nameplateNumber(compressor, 'rated_kw'), capacityKgH: nameplateNumber(compressor, 'capacity_kg_h') },
  );
}

/** 초기 재고는 220 bar·20 °C. 압축기 누적 운전시간·전력량은 준공 후 추정치 */
export function createStorage(init: InitContext, compressorHours: number, suctionBar: number, initialBar = INITIAL_STORAGE_BAR): StorageUnit {
  const tanks = assetsOfClass(init.site, 'h2.storage.tank').map((a): TankUnit => ({ code: a.code, pressureOffsetBar: 0.4 * init.rng.gaussian(), tempOffsetC: 0.3 * init.rng.gaussian() }));
  const detectors = assetsOfClass(init.site, 'h2.detector').map((a) => ({ code: a.code, baselinePpm: 6 + 6 * init.rng.next() }));
  const params = buildParams(init.site, tanks.length);
  const state = initialStorageState(params, Math.min(initialBar, params.maxBar), INITIAL_TEMP_C, { runHours: compressorHours, energyKwh: compressorHours * 16 });
  const idle = { inflowKgH: 0, directInflowKgH: 0, outflowKgH: 0, suctionBar, ambientC: INITIAL_TEMP_C, envTempC: INITIAL_TEMP_C, tankLeakKgPerDay: tanks.map(() => 0), valveWear: 0, sealLeakBar: 0, dtS: 0 };
  return {
    bankCode: singleAsset(init.site, 'h2.storage.bank').code,
    compressorCode: singleAsset(init.site, 'h2.compressor').code,
    params,
    step: stepStorage(params, state, idle),
    tanks,
    detectors,
  };
}

export function stepStorageUnit(unit: StorageUnit, flows: StorageFlows, ctx: StepContext): StorageUnit {
  const { weather, degradation, tMs } = ctx;
  const step = stepStorage(unit.params, unit.step.state, {
    ...flows,
    ambientC: weather.ambientC,
    envTempC: weather.ambientC + (TANK_SOLAR_GAIN_C * weather.ghi) / 1000 + ctx.p3.tankSwingC,
    tankLeakKgPerDay: unit.tanks.map((t) => degradation.value('storage.leakKgPerDay', t.code, tMs)),
    valveWear: degradation.value('compressor.valveWear', unit.compressorCode, tMs),
    sealLeakBar: degradation.value('compressor.sealLeakBar', unit.compressorCode, tMs),
    dtS: ctx.dtS,
  });
  return { ...unit, step };
}

export interface StorageReadingView {
  /** 전해조가 가압 상태(정지 아님)면 압축기 흡입에 전해조 출구 압력이 걸린다 */
  readonly elzPressurized: boolean;
  readonly suctionBar: number;
  readonly fcDrawing: boolean;
}

/** 현장 PLC 재고: 용기별 측정 압력·온도(교정 오프셋 포함)로 단순 상태식 질량을 더한다 */
function plcInventoryKg(unit: StorageUnit): number {
  const { step, params } = unit;
  return sumOf(unit.tanks.map((t, i) => plcH2MassKg(Math.max(0, (step.tankPressureBar[i] ?? 0) + t.pressureOffsetBar), params.tankVolumeM3, step.state.gasTempC + t.tempOffsetC)));
}

export function storageReadings(unit: StorageUnit, view: StorageReadingView, extraPpm: (detectorCode: string) => number): readonly ReadingEntry[] {
  const { step } = unit;
  const on = step.state.compressorOn;
  const compressor = step.state.compressor;
  return [
    [unit.compressorCode, {
      'compressor.power': step.compressorKw,
      'compressor.suction.pressure': view.elzPressurized ? view.suctionBar : SUCTION_IDLE_BAR,
      'compressor.discharge.pressure': step.dischargeBar,
      'compressor.discharge.temp': compressor.dischargeTempC,
      'compressor.leak.pressure': compressor.leakDetectBar,
      'ac.energy.total': compressor.energyKwh,
      'run.hours': compressor.runHours,
      'op.state': on ? OP_STATE.RUNNING : OP_STATE.STANDBY,
      'vibration.rms': on ? 1.8 : 0.2,
    }],
    [unit.bankCode, {
      'h2.inventory': plcInventoryKg(unit),
      'valve.open#inlet': on ? 1 : 0,
      'valve.open#outlet': view.fcDrawing ? 1 : 0,
    }],
    ...unit.tanks.map((tank, i): ReadingEntry => [tank.code, {
      'tank.pressure': Math.max(0, (step.tankPressureBar[i] ?? 0) + tank.pressureOffsetBar),
      'tank.temp': step.state.gasTempC + tank.tempOffsetC,
    }]),
    ...unit.detectors.map((d): ReadingEntry => [d.code, { 'gas.detector.ppm': d.baselinePpm + extraPpm(d.code) }]),
  ];
}
