// P3 고장 시나리오: 수소 저장·압축기·전해조 비에너지·연료전지 블로워·태양광 오염·랙 저항·인버터 냉각팬.
// startDay·rainDays·cleaningDay·cleanedDay는 실행 기준일(실행 시작 시각이 속한 KST 날짜 0시)부터 센 일수다.
// 결과는 열화 파라미터 hook(P2와 같은 인터페이스)과, 기상·운영 이벤트(강한 비·모듈 세척·필터 교체)다.
import type { AssetDef, SiteDef } from '@/db/seed/types';
import type { AssetMoment, P3EventPlan } from './control-scenarios-p3';
import { EMPTY_P3_EVENT_PLAN } from './control-scenarios-p3';
import { levelRampHook, levelRampUntilHook, rateFromHook, type DegradationHook, type DegradationParam, type FaultScenario } from './degradation';
import { assetOfClass, DAYS_PER_MONTH, hookFor, requireRange, startMsOf } from './fault-scenarios';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { solveIncreasing } from './models/common';
import { operatingPoint } from './models/electrolyzer';
import { singleAsset } from './plant-types';
import { electrolyzerParamsOf } from './site-params';

export const P3_FAULT_DEFAULTS = Object.freeze({
  /** 수준형 고장(비에너지·밸브·필터·저항)이 목표 크기에 도달하는 기본 일수 */
  rampDays: 60,
  /** 냉각팬 고장: 방열판 온도 상승폭 2배 */
  fanCoolingLoss: 1,
  /** 누설 감지 포트 압력 상승 상한 [bar] */
  sealLeakCapBar: 50,
  /** 오염 고장 강우일: KST 03~09시 강한 비 */
  rainStartHour: 3,
  rainHours: 6,
  /** 모듈 세척·필터 교체 시각 (KST) */
  maintenanceHour: 10,
  /** 전해조 비에너지 크기 보정 기준: 정격 전류·60 °C·열화 없음 */
  secReferenceTempC: 60,
});

/** 저장용기 누설: startDay부터 kgPerDay, escalations의 날부터 그 크기로 바뀐다 (계단) */
export interface TankLeakFault {
  readonly kind: 'fault.tank_leak';
  readonly site: string;
  /** 용기 설비 코드 (예: H2BANK1/TANK2) */
  readonly tank: string;
  readonly kgPerDay: number;
  readonly startDay: number;
  readonly escalations?: readonly { readonly day: number; readonly kgPerDay: number }[];
}
/** 전해조 수소 유량계 이득 드리프트: 한 달에 pctPerMonth%씩 (+면 과대 계량) */
export interface FlowmeterDriftFault {
  readonly kind: 'fault.flowmeter_drift';
  readonly site: string;
  readonly pctPerMonth: number;
  readonly startDay?: number;
}
export type ElzSecRiseMode = 'rectifier' | 'faradaic' | 'stack';
/** 전해조 비에너지(kWh/kg) pct% 상승: 정류기 효율 저하 · 패러데이 효율 저하 · 셀 전압 상승 중 한 경로 (정격 전류 기준 보정) */
export interface ElzSecRiseFault {
  readonly kind: 'fault.elz_sec_rise';
  readonly site: string;
  readonly mode: ElzSecRiseMode;
  readonly pct: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 압축기 밸브 마모: 같은 압력비에서 비일 pct% 상승 + 토출 온도 상승 */
export interface CompressorValveWearFault {
  readonly kind: 'fault.compressor_valve_wear';
  readonly site: string;
  readonly pct: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 압축기 다이어프램·씰 누설: 운전 중 누설 감지 포트 압력이 하루 rate bar씩 오르고 누설분만큼 수소를 잃는다 */
export interface CompressorLeakSealFault {
  readonly kind: 'fault.compressor_leak_seal';
  readonly site: string;
  readonly rate: number;
  readonly startDay?: number;
}
/** 연료전지 블로워 마모: 같은 유량에서 전력이 한 달에 pctPerMonth%씩 는다 */
export interface FcBlowerWearFault {
  readonly kind: 'fault.fc_blower_wear';
  readonly site: string;
  readonly pctPerMonth: number;
  readonly startDay?: number;
}
/** 연료전지 공기 필터 막힘: 블로워 전력 pct% 상승까지 램프, cleanedDay에 필터 교체(asset_event)로 회복 */
export interface FcAirFilterClogFault {
  readonly kind: 'fault.fc_air_filter_clog';
  readonly site: string;
  readonly pct: number;
  readonly startDay?: number;
  readonly rampDays?: number;
  readonly cleanedDay?: number;
}
/** 태양광 끈적한 오염층: 하루 pctPerDay%씩 쌓이고 rainDays의 강한 비·cleaningDay 세척(asset_event)으로만 씻긴다 */
export interface PvSoilingFault {
  readonly kind: 'fault.pv_soiling';
  readonly site: string;
  /** 인버터 설비 코드. 생략하면 사이트 전 인버터 */
  readonly asset?: string;
  readonly pctPerDay: number;
  readonly startDay?: number;
  readonly rainDays?: readonly number[];
  readonly cleaningDay?: number;
}
/** 랙 내부저항 pct% 증가 (램프) */
export interface RackResistanceGrowthFault {
  readonly kind: 'fault.rack_resistance_growth';
  readonly site: string;
  readonly rack: string;
  readonly pct: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 인버터 냉각팬 고장: 방열 저하로 방열판 온도가 올라 저감 시작 온도를 넘는 날에만 출력이 줄어든다 */
export interface InverterFanFailureFault {
  readonly kind: 'fault.inverter_fan_failure';
  readonly site: string;
  readonly inverter: string;
  readonly startDay: number;
}

export type P3FaultScenario =
  | TankLeakFault
  | FlowmeterDriftFault
  | ElzSecRiseFault
  | CompressorValveWearFault
  | CompressorLeakSealFault
  | FcBlowerWearFault
  | FcAirFilterClogFault
  | PvSoilingFault
  | RackResistanceGrowthFault
  | InverterFanFailureFault;

export type P3FaultKind = P3FaultScenario['kind'];

export const P3_FAULT_KINDS: readonly P3FaultKind[] = [
  'fault.tank_leak',
  'fault.flowmeter_drift',
  'fault.elz_sec_rise',
  'fault.compressor_valve_wear',
  'fault.compressor_leak_seal',
  'fault.fc_blower_wear',
  'fault.fc_air_filter_clog',
  'fault.pv_soiling',
  'fault.rack_resistance_growth',
  'fault.inverter_fan_failure',
];

export const isP3Fault = (scenario: { readonly kind: string }): scenario is P3FaultScenario => (P3_FAULT_KINDS as readonly string[]).includes(scenario.kind);

export interface ResolvedP3Fault {
  readonly hooks: readonly FaultScenario[];
  readonly events: P3EventPlan;
  /** 정답 행 설비 코드 (여러 설비면 행을 나눈다) */
  readonly assetCodes: readonly string[];
  readonly startMs: number;
  /** 크기가 목표에 다 도달하는 시각 */
  readonly fullEffectMs: number;
  /** 회복 시각 (필터 교체). null이면 실행 끝까지 */
  readonly recoveredMs: number | null;
  readonly params: Readonly<Record<string, number | string>>;
}

function rampDaysOf(value: number | undefined, label: string): number {
  const days = value ?? P3_FAULT_DEFAULTS.rampDays;
  if (!Number.isFinite(days) || days < 0 || days > 3_650) throw new Error(`${label} rampDays는 0~3650: ${days}`);
  return days;
}

function laterDayMs(originMs: number, day: number, afterMs: number, label: string): number {
  if (!Number.isFinite(day) || day < 0) throw new Error(`${label}는 0 이상이어야 합니다: ${day}`);
  const atMs = originMs + day * MS_PER_DAY;
  if (atMs <= afterMs) throw new Error(`${label}(${day}일)는 고장 시작보다 뒤여야 합니다`);
  return atMs;
}

const single = (hook: FaultScenario, assetCode: string, startMs: number, fullEffectMs: number, params: ResolvedP3Fault['params']): ResolvedP3Fault => ({
  hooks: [hook],
  events: EMPTY_P3_EVENT_PLAN,
  assetCodes: [assetCode],
  startMs,
  fullEffectMs,
  recoveredMs: null,
  params,
});

function resolveTankLeak(site: SiteDef, fault: TankLeakFault, originMs: number): ResolvedP3Fault {
  const asset = assetOfClass(site, fault.tank, 'storage.leakKgPerDay', fault.kind);
  const kgPerDay = requireRange(fault.kgPerDay, `${fault.kind} kgPerDay`, 0, 50);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const steps = [...(fault.escalations ?? [])]
    .map((e) => ({ atMs: laterDayMs(originMs, e.day, startMs, `${fault.kind} escalations.day`), kgPerDay: requireRange(e.kgPerDay, `${fault.kind} escalations.kgPerDay`, 0, 50) }))
    .sort((a, b) => a.atMs - b.atMs);
  const schedule = [{ atMs: startMs, kgPerDay }, ...steps];
  const value: DegradationHook = (tMs, baseline) => baseline + (schedule.findLast((s) => s.atMs <= tMs)?.kgPerDay ?? 0);
  const last = schedule[schedule.length - 1] ?? { atMs: startMs, kgPerDay };
  return single(hookFor(site, 'storage.leakKgPerDay', asset.code, value), asset.code, startMs, last.atMs, {
    tank: asset.code,
    kgPerDay,
    maxKgPerDay: Math.max(...schedule.map((s) => s.kgPerDay)),
    schedule: schedule.map((s) => `${s.kgPerDay}@${s.atMs}`).join(';'),
  });
}

function resolveFlowmeterDrift(site: SiteDef, fault: FlowmeterDriftFault, originMs: number): ResolvedP3Fault {
  const elz = singleAsset(site, 'h2.elz');
  const pct = fault.pctPerMonth;
  if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 10) throw new Error(`${fault.kind} pctPerMonth는 0이 아닌 −10~10: ${pct}`);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const value: DegradationHook = (tMs, baseline) => (tMs < startMs ? baseline : baseline * Math.max(0.1, 1 + (pct / 100) * ((tMs - startMs) / MS_PER_DAY / DAYS_PER_MONTH)));
  return single(hookFor(site, 'meter.h2FlowGain', elz.code, value), elz.code, startMs, startMs, { pctPerMonth: pct, meter: 'h2.flow.mass' });
}

interface SecCalibration {
  readonly param: DegradationParam;
  readonly faultAsset: AssetDef;
  readonly magnitude: number;
  readonly params: Readonly<Record<string, number | string>>;
}

/** 정격 전류·60 °C·열화 없음에서 설비 AC 비에너지가 pct% 오르도록 경로별 크기를 정한다 */
function calibrateSec(site: SiteDef, mode: ElzSecRiseMode, pct: number): SecCalibration {
  const params = electrolyzerParamsOf(site);
  const tempC = P3_FAULT_DEFAULTS.secReferenceTempC;
  const reference = operatingPoint(params, params.ratedCurrentA, tempC, 0);
  const p = pct / 100;
  switch (mode) {
    case 'rectifier': {
      const extra = (p * reference.totalAcKw) / reference.rectifierAcKw;
      return { param: 'elz.rectifierLossExtra', faultAsset: singleAsset(site, 'h2.elz.rectifier'), magnitude: extra, params: { rectifierLossExtra: extra, rectifierEfficiencyAfter: reference.dcKw / (reference.rectifierAcKw * (1 + extra)) } };
    }
    case 'faradaic': {
      const loss = p / (1 + p);
      return { param: 'elz.faradaicLoss', faultAsset: singleAsset(site, 'h2.elz.stack'), magnitude: loss, params: { faradaicLoss: loss } };
    }
    case 'stack': {
      const target = reference.totalAcKw * (1 + p);
      const extraV = solveIncreasing((v) => operatingPoint(params, params.ratedCurrentA, tempC, 0, { rectifierLossExtra: 0, faradaicLoss: 0, extraCellVoltageV: v }).totalAcKw, target, 0, 1);
      return { param: 'elz.extraCellVoltageV', faultAsset: singleAsset(site, 'h2.elz.stack'), magnitude: extraV, params: { extraCellVoltageMv: extraV * 1000, referenceCellVoltageV: reference.cellVoltageV } };
    }
  }
}

function resolveElzSecRise(site: SiteDef, fault: ElzSecRiseFault, originMs: number): ResolvedP3Fault {
  if (!['rectifier', 'faradaic', 'stack'].includes(fault.mode)) throw new Error(`${fault.kind} mode는 rectifier | faradaic | stack: ${String(fault.mode)}`);
  const pct = requireRange(fault.pct, `${fault.kind} pct`, 0, 50);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const rampDays = rampDaysOf(fault.rampDays, fault.kind);
  const calibration = calibrateSec(site, fault.mode, pct);
  const elz = singleAsset(site, 'h2.elz');
  const hook = hookFor(site, calibration.param, calibration.faultAsset.code, levelRampHook(startMs, rampDays * MS_PER_DAY, calibration.magnitude));
  return single(hook, elz.code, startMs, startMs + rampDays * MS_PER_DAY, { mode: fault.mode, pct, rampDays, faultAsset: calibration.faultAsset.code, ...calibration.params });
}

function resolveLevelRamp(site: SiteDef, fault: CompressorValveWearFault | RackResistanceGrowthFault, originMs: number): ResolvedP3Fault {
  const [param, asset, max] =
    fault.kind === 'fault.compressor_valve_wear'
      ? (['compressor.valveWear', singleAsset(site, 'h2.compressor'), 100] as const)
      : (['battery.resistanceGrowth', assetOfClass(site, fault.rack, 'battery.resistanceGrowth', fault.kind), 300] as const);
  const pct = requireRange(fault.pct, `${fault.kind} pct`, 0, max);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const rampDays = rampDaysOf(fault.rampDays, fault.kind);
  return single(hookFor(site, param, asset.code, levelRampHook(startMs, rampDays * MS_PER_DAY, pct / 100)), asset.code, startMs, startMs + rampDays * MS_PER_DAY, { pct, rampDays });
}

function resolveSealLeak(site: SiteDef, fault: CompressorLeakSealFault, originMs: number): ResolvedP3Fault {
  const compressor = singleAsset(site, 'h2.compressor');
  const rate = requireRange(fault.rate, `${fault.kind} rate`, 0, 5);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const cap = P3_FAULT_DEFAULTS.sealLeakCapBar;
  const value: DegradationHook = (tMs, baseline) => baseline + Math.min(cap, (rate * Math.max(0, tMs - startMs)) / MS_PER_DAY);
  return single(hookFor(site, 'compressor.sealLeakBar', compressor.code, value), compressor.code, startMs, startMs + (cap / rate) * MS_PER_DAY, { rateBarPerDay: rate, capBar: cap });
}

function resolveBlowerWear(site: SiteDef, fault: FcBlowerWearFault, originMs: number): ResolvedP3Fault {
  const blower = singleAsset(site, 'fc.blower');
  const growth = requireRange(fault.pctPerMonth, `${fault.kind} pctPerMonth`, 0, 50) / 100;
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  // 전력 배율 1/(1 − wear) = 1 + growth × 개월 → wear = 1 − (1 − 기본)/(1 + growth × 개월)
  const value: DegradationHook = (tMs, baseline) => (tMs < startMs ? baseline : 1 - (1 - baseline) / (1 + (growth * (tMs - startMs)) / MS_PER_DAY / DAYS_PER_MONTH));
  return single(hookFor(site, 'blower.wear', blower.code, value), blower.code, startMs, startMs, { pctPerMonth: growth * 100 });
}

function resolveFilterClog(site: SiteDef, fault: FcAirFilterClogFault, originMs: number): ResolvedP3Fault {
  const blower = singleAsset(site, 'fc.blower');
  const pct = requireRange(fault.pct, `${fault.kind} pct`, 0, 200);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const rampDays = rampDaysOf(fault.rampDays, fault.kind);
  const cleanedMs = fault.cleanedDay === undefined ? null : laterDayMs(originMs, fault.cleanedDay, startMs, `${fault.kind} cleanedDay`) + P3_FAULT_DEFAULTS.maintenanceHour * MS_PER_HOUR;
  const hook = hookFor(site, 'blower.filterClog', blower.code, levelRampUntilHook(startMs, rampDays * MS_PER_DAY, pct / 100, cleanedMs ?? Infinity));
  const replacements: AssetMoment[] = cleanedMs === null ? [] : [{ atMs: cleanedMs, assetCode: blower.code }];
  return {
    ...single(hook, blower.code, startMs, startMs + rampDays * MS_PER_DAY, { pct, rampDays, ...(cleanedMs === null ? {} : { cleanedTs: cleanedMs }) }),
    events: { ...EMPTY_P3_EVENT_PLAN, filterReplacements: replacements },
    recoveredMs: cleanedMs,
  };
}

function resolvePvSoiling(site: SiteDef, fault: PvSoilingFault, originMs: number): ResolvedP3Fault {
  const inverters = fault.asset === undefined ? site.assets.filter((a) => a.classKey === 'pv.inverter') : [assetOfClass(site, fault.asset, 'pv.stickySoilingPerDay', fault.kind)];
  if (inverters.length === 0) throw new Error(`${fault.kind}: ${site.code}에 pv.inverter 설비가 없습니다`);
  const pctPerDay = requireRange(fault.pctPerDay, `${fault.kind} pctPerDay`, 0, 5);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const rainDays = [...(fault.rainDays ?? [])].sort((a, b) => a - b);
  const rainWindows = rainDays.map((day) => {
    const at = laterDayMs(originMs, day, startMs - 1, `${fault.kind} rainDays`) + P3_FAULT_DEFAULTS.rainStartHour * MS_PER_HOUR;
    return { startMs: at, endMs: at + P3_FAULT_DEFAULTS.rainHours * MS_PER_HOUR };
  });
  const cleaningMs = fault.cleaningDay === undefined ? null : laterDayMs(originMs, fault.cleaningDay, startMs - 1, `${fault.kind} cleaningDay`) + P3_FAULT_DEFAULTS.maintenanceHour * MS_PER_HOUR;
  const plant = singleAsset(site, 'pv.plant');
  const rate = pctPerDay / 100;
  const hooks = fault.asset === undefined
    ? [{ kind: 'fault', site: site.code, param: 'pv.stickySoilingPerDay', value: rateFromHook(startMs, rate) } satisfies FaultScenario]
    : inverters.map((a) => hookFor(site, 'pv.stickySoilingPerDay', a.code, rateFromHook(startMs, rate)));
  return {
    hooks,
    events: { ...EMPTY_P3_EVENT_PLAN, rainWindows, pvCleanings: cleaningMs === null ? [] : [{ atMs: cleaningMs, assetCode: plant.code }] },
    assetCodes: inverters.map((a) => a.code),
    startMs,
    fullEffectMs: startMs,
    recoveredMs: null,
    params: { pctPerDay, rainDays: rainDays.join(','), ...(cleaningMs === null ? {} : { cleaningTs: cleaningMs }) },
  };
}

function resolveFanFailure(site: SiteDef, fault: InverterFanFailureFault, originMs: number): ResolvedP3Fault {
  const inverter = assetOfClass(site, fault.inverter, 'inverter.coolingLoss', fault.kind);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const loss = P3_FAULT_DEFAULTS.fanCoolingLoss;
  return single(hookFor(site, 'inverter.coolingLoss', inverter.code, levelRampHook(startMs, 0, loss)), inverter.code, startMs, startMs, { coolingLoss: loss });
}

/** P3 고장 시나리오를 설비·시각·hook·이벤트로 푼다. 설비가 없거나 크기가 범위 밖이면 오류. */
export function resolveP3Fault(site: SiteDef, fault: P3FaultScenario, originMs: number): ResolvedP3Fault {
  switch (fault.kind) {
    case 'fault.tank_leak':
      return resolveTankLeak(site, fault, originMs);
    case 'fault.flowmeter_drift':
      return resolveFlowmeterDrift(site, fault, originMs);
    case 'fault.elz_sec_rise':
      return resolveElzSecRise(site, fault, originMs);
    case 'fault.compressor_valve_wear':
    case 'fault.rack_resistance_growth':
      return resolveLevelRamp(site, fault, originMs);
    case 'fault.compressor_leak_seal':
      return resolveSealLeak(site, fault, originMs);
    case 'fault.fc_blower_wear':
      return resolveBlowerWear(site, fault, originMs);
    case 'fault.fc_air_filter_clog':
      return resolveFilterClog(site, fault, originMs);
    case 'fault.pv_soiling':
      return resolvePvSoiling(site, fault, originMs);
    case 'fault.inverter_fan_failure':
      return resolveFanFailure(site, fault, originMs);
  }
}
