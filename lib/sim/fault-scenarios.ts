// 고장 시나리오 (P2): 시작일·램프·크기를 열화 파라미터 hook으로 바꾼다.
// startDay는 실행 기준일(실행 시작 시각이 속한 KST 날짜 0시)부터 센 일수다. 0이면 기준일 0시.
import type { AssetDef, SiteDef } from '@/db/seed/types';
import {
  DEGRADATION_PARAMS,
  extraRateHook,
  levelRampHook,
  linearGrowthHook,
  rateFromHook,
  type DegradationHook,
  type DegradationParam,
  type FaultScenario,
} from './degradation';
import { kstDateToMs, MS_PER_DAY } from './math';
import { singleAsset } from './plant-types';

/** mV/월 → mV/일 환산에 쓰는 한 달 일수 */
export const DAYS_PER_MONTH = 365.25 / 12;

/** 랙 용량 감소: startDay부터 days일에 걸쳐 시작 시점 용량의 totalPct%를 선형으로 잃는다 (기본 열화에 더해짐). */
export interface BatteryCapacityFadeFault {
  readonly kind: 'fault.battery_capacity_fade';
  readonly site: string;
  readonly asset: string;
  readonly startDay: number;
  readonly totalPct: number;
  readonly days: number;
}

/** 셀 불균형(밸런싱 불량): startDay부터 최고·최저 셀 전압 차이가 SOC·전류와 무관하게 한 달에 mVPerMonth씩 커진다. */
export interface CellImbalanceFault {
  readonly kind: 'fault.cell_imbalance';
  readonly site: string;
  readonly asset: string;
  readonly mVPerMonth: number;
  readonly startDay?: number;
}

/** 인버터 효율 저하: startDay부터 rampDays(기본 0 = 계단)에 걸쳐 효율이 pctPoints %p 떨어진다. */
export interface InverterEfficiencyDropFault {
  readonly kind: 'fault.inverter_efficiency_drop';
  readonly site: string;
  readonly asset: string;
  readonly pctPoints: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}

/** 전해 스택 열화: startDay부터 셀당 전압 상승률(운전시간 기준)을 uvPerH로 바꾼다 (기본값 대체). */
export interface ElzStackDegradationFault {
  readonly kind: 'fault.elz_stack_degradation';
  readonly site: string;
  readonly uvPerH: number;
  readonly startDay?: number;
}

/** 연료전지 전압 감쇠: startDay부터 셀당 전압 감쇠율(운전시간 기준)을 uvPerH로 바꾼다 (기본값 대체). */
export interface FcVoltageDecayFault {
  readonly kind: 'fault.fc_voltage_decay';
  readonly site: string;
  readonly uvPerH: number;
  readonly startDay?: number;
}

export type TypedFaultScenario =
  | BatteryCapacityFadeFault
  | CellImbalanceFault
  | InverterEfficiencyDropFault
  | ElzStackDegradationFault
  | FcVoltageDecayFault;

export type TypedFaultKind = TypedFaultScenario['kind'];

export interface ResolvedFault {
  /** 열화 파라미터 hook (계획에 넣는 형태) */
  readonly hook: FaultScenario;
  readonly assetCode: string;
  readonly startMs: number;
  /** 크기가 목표에 다 도달하는 시각 (율 대체형은 startMs) */
  readonly fullEffectMs: number;
  /** 정답 기록용 파라미터 (입력값 + 모델 기본값) */
  readonly params: Readonly<Record<string, number>>;
}

function requireRange(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= min || value > max) throw new Error(`${label}은(는) ${min} 초과 ${max} 이하여야 합니다: ${value}`);
  return value;
}

function startMsOf(originMs: number, startDay: number | undefined, label: string): number {
  const day = startDay ?? 0;
  if (!Number.isFinite(day) || day < 0) throw new Error(`${label} startDay는 0 이상이어야 합니다: ${day}`);
  return originMs + day * MS_PER_DAY;
}

function assetOfClass(site: SiteDef, code: string, param: DegradationParam, label: string): AssetDef {
  const classKey = DEGRADATION_PARAMS[param].classKey;
  const asset = site.assets.find((a) => a.code === code && a.classKey === classKey);
  if (!asset) throw new Error(`${label}: ${site.code}에 ${classKey} 설비 ${code}이(가) 없습니다`);
  return asset;
}

const hookFor = (site: SiteDef, param: DegradationParam, asset: string, value: DegradationHook): FaultScenario => ({ kind: 'fault', site: site.code, param, asset, value });

function resolveCapacityFade(site: SiteDef, fault: BatteryCapacityFadeFault, originMs: number): ResolvedFault {
  const param = 'battery.capacityFadePerDay';
  const asset = assetOfClass(site, fault.asset, param, fault.kind);
  const totalPct = requireRange(fault.totalPct, `${fault.kind} totalPct`, 0, 50);
  const days = requireRange(fault.days, `${fault.kind} days`, 0, 3_650);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const baseline = DEGRADATION_PARAMS[param].baseline;
  // 모델은 준공일부터 기본 감소율로 SOH를 적분하므로 시작 시점 SOH를 같은 식으로 구해 상대 감소율로 바꾼다.
  const sohAtStart = Math.max(0.5, 1 - (baseline * (startMs - kstDateToMs(asset.commissionedAt))) / MS_PER_DAY);
  const extraPerDay = (sohAtStart * totalPct) / 100 / days;
  const endMs = startMs + days * MS_PER_DAY;
  return {
    hook: hookFor(site, param, asset.code, extraRateHook(startMs, endMs, extraPerDay)),
    assetCode: asset.code,
    startMs,
    fullEffectMs: endMs,
    params: { totalPct, days, sohAtStart, extraFadePerDay: extraPerDay, baselineFadePerDay: baseline },
  };
}

function resolveCellImbalance(site: SiteDef, fault: CellImbalanceFault, originMs: number): ResolvedFault {
  const param = 'battery.cellSpreadMv';
  const asset = assetOfClass(site, fault.asset, param, fault.kind);
  const mVPerMonth = requireRange(fault.mVPerMonth, `${fault.kind} mVPerMonth`, 0, 100);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  return {
    hook: hookFor(site, param, asset.code, linearGrowthHook(startMs, mVPerMonth / DAYS_PER_MONTH)),
    assetCode: asset.code,
    startMs,
    fullEffectMs: startMs,
    params: { mVPerMonth },
  };
}

function resolveInverterDrop(site: SiteDef, fault: InverterEfficiencyDropFault, originMs: number): ResolvedFault {
  const param = 'inverter.efficiencyDrop';
  const asset = assetOfClass(site, fault.asset, param, fault.kind);
  const pctPoints = requireRange(fault.pctPoints, `${fault.kind} pctPoints`, 0, 20);
  const rampDays = fault.rampDays ?? 0;
  if (!Number.isFinite(rampDays) || rampDays < 0) throw new Error(`${fault.kind} rampDays는 0 이상이어야 합니다: ${rampDays}`);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  const rampMs = rampDays * MS_PER_DAY;
  return {
    hook: hookFor(site, param, asset.code, levelRampHook(startMs, rampMs, pctPoints / 100)),
    assetCode: asset.code,
    startMs,
    fullEffectMs: startMs + rampMs,
    params: { pctPoints, rampDays },
  };
}

function resolveStackRate(site: SiteDef, fault: ElzStackDegradationFault | FcVoltageDecayFault, originMs: number): ResolvedFault {
  const [param, classKey] =
    fault.kind === 'fault.elz_stack_degradation' ? (['elz.degradationUvPerH', 'h2.elz.stack'] as const) : (['fc.voltageDecayUvPerH', 'fc.stack'] as const);
  const asset = singleAsset(site, classKey);
  const uvPerH = requireRange(fault.uvPerH, `${fault.kind} uvPerH`, 0, 1_000);
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  return {
    hook: hookFor(site, param, asset.code, rateFromHook(startMs, uvPerH)),
    assetCode: asset.code,
    startMs,
    fullEffectMs: startMs,
    params: { uvPerH, baselineUvPerH: DEGRADATION_PARAMS[param].baseline },
  };
}

export const TYPED_FAULT_KINDS: readonly TypedFaultKind[] = [
  'fault.battery_capacity_fade',
  'fault.cell_imbalance',
  'fault.inverter_efficiency_drop',
  'fault.elz_stack_degradation',
  'fault.fc_voltage_decay',
];

export const isTypedFault = (scenario: { readonly kind: string }): scenario is TypedFaultScenario =>
  (TYPED_FAULT_KINDS as readonly string[]).includes(scenario.kind);

/** 고장 시나리오를 설비·시각·hook으로 푼다. 설비가 없거나 크기가 범위 밖이면 오류. */
export function resolveFault(site: SiteDef, fault: TypedFaultScenario, originMs: number): ResolvedFault {
  switch (fault.kind) {
    case 'fault.battery_capacity_fade':
      return resolveCapacityFade(site, fault, originMs);
    case 'fault.cell_imbalance':
      return resolveCellImbalance(site, fault, originMs);
    case 'fault.inverter_efficiency_drop':
      return resolveInverterDrop(site, fault, originMs);
    case 'fault.elz_stack_degradation':
    case 'fault.fc_voltage_decay':
      return resolveStackRate(site, fault, originMs);
  }
}
