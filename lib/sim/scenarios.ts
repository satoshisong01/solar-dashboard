// 시뮬레이션 시나리오 타입과 적용기.
// P1: healthy · 데이터 품질(dq.*) · 안전 경보. P2용 고장 주입은 인터페이스(열화 파라미터 hook)와 파라미터 반영까지만 둔다.
import type { AssetDef, SiteDef } from '@/db/seed/types';
import { MS_PER_SECOND, toEpochMs, type TimeInput } from './math';

/**
 * 열화 파라미터. baseline은 건강한 설비의 기본값이다.
 * - 비율/일, µV/h, kg/일 같은 "율"은 모델이 시간에 따라 적분한다.
 * - cellImbalance·efficiencyDrop·wear 같은 "수준"은 그 시각 값을 그대로 쓴다.
 */
export const DEGRADATION_PARAMS = Object.freeze({
  /** 랙 용량 감소율 [비율/일] (0.00005 ≈ 연 1.8%) */
  'battery.capacityFadePerDay': { classKey: 'ess.rack', baseline: 0.000_05 },
  /** 최강·최약 셀 SOC 차이 [비율] */
  'battery.cellImbalance': { classKey: 'ess.rack', baseline: 0.01 },
  /** 인버터 효율 절대 저하 [비율, 0.01 = 1%p] */
  'inverter.efficiencyDrop': { classKey: 'pv.inverter', baseline: 0 },
  /** 전해 스택 셀당 전압 상승률 [µV/h] */
  'elz.degradationUvPerH': { classKey: 'h2.elz.stack', baseline: 4 },
  /** 연료전지 셀당 전압 감쇠율 [µV/h] */
  'fc.voltageDecayUvPerH': { classKey: 'fc.stack', baseline: 6 },
  /** 저장뱅크 누설 [kg/일] */
  'storage.leakKgPerDay': { classKey: 'h2.storage.bank', baseline: 0 },
  /** 인버터 어레이 오염 누적률 [비율/일] (강우 시 초기화) */
  'pv.soilingPerDay': { classKey: 'pv.inverter', baseline: 0.001 },
  /** 블로워 마모 [0~0.9] — 같은 유량에 전력 1/(1−wear)배 */
  'blower.wear': { classKey: 'fc.blower', baseline: 0 },
});

export type DegradationParam = keyof typeof DEGRADATION_PARAMS;

/** 시각 [epoch ms]과 기본값을 받아 그 시각의 파라미터 값을 돌려준다. */
export type DegradationHook = (tMs: number, baseline: number) => number;

export interface HealthyScenario {
  readonly kind: 'healthy';
}
export interface GatewayOutageScenario {
  readonly kind: 'dq.gateway_outage';
  readonly site: string;
  readonly start: TimeInput;
  readonly durationS: number;
}
export interface DuplicateBatchesScenario {
  readonly kind: 'dq.duplicate_batches';
  readonly site: string;
  /** 배치를 한 번 더 보낼 확률 (0~1) */
  readonly ratio: number;
}
export interface StuckSensorScenario {
  readonly kind: 'dq.stuck_sensor';
  readonly site: string;
  readonly sourceKey: string;
  readonly start: TimeInput;
  readonly durationS: number;
}
export interface SpikeScenario {
  readonly kind: 'dq.spike';
  readonly site: string;
  readonly sourceKey: string;
  /** 하루 평균 스파이크 수 */
  readonly perDay: number;
  /** 스파이크 크기 = max(|값|, 기준폭) × magnitude (기본 3) */
  readonly magnitude?: number;
}
export interface ClockSkewScenario {
  readonly kind: 'dq.clock_skew';
  readonly site: string;
  /** 게이트웨이 시계 오차 [초] (+면 빠름). 실행 내내 일정 */
  readonly skewS: number;
}
export interface H2LeakAlarmScenario {
  readonly kind: 'safety.h2_leak_alarm';
  readonly site: string;
  readonly at: TimeInput;
  /** 수소 검지기 설비 코드. 생략하면 저장뱅크(H2BANK1) 위치 검지기 */
  readonly detector?: string;
}
/** P2 고장 주입 인터페이스: 열화 파라미터를 시간 함수로 덮어쓴다. */
export interface FaultScenario {
  readonly kind: 'fault';
  readonly site: string;
  readonly param: DegradationParam;
  /** 설비 코드. 생략하면 사이트 안 해당 종류 설비 전부 */
  readonly asset?: string;
  readonly value: DegradationHook;
}

export type Scenario =
  | HealthyScenario
  | GatewayOutageScenario
  | DuplicateBatchesScenario
  | StuckSensorScenario
  | SpikeScenario
  | ClockSkewScenario
  | H2LeakAlarmScenario
  | FaultScenario;

export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SiteScenarioPlan {
  readonly outages: readonly TimeWindow[];
  readonly duplicateRatio: number;
  readonly clockSkewMs: number;
  readonly stuckSensors: readonly (TimeWindow & { readonly sourceKey: string })[];
  readonly spikes: readonly { readonly sourceKey: string; readonly perDay: number; readonly magnitude: number }[];
  readonly leakAlarms: readonly { readonly atMs: number; readonly detector: string }[];
  readonly faults: readonly FaultScenario[];
}

export const EMPTY_PLAN: SiteScenarioPlan = Object.freeze({
  outages: [],
  duplicateRatio: 0,
  clockSkewMs: 0,
  stuckSensors: [],
  spikes: [],
  leakAlarms: [],
  faults: [],
});

const DEFAULT_SPIKE_MAGNITUDE = 3;

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}은(는) 0보다 커야 합니다: ${value}`);
  return value;
}

function windowOf(start: TimeInput, durationS: number, label: string): TimeWindow {
  const startMs = toEpochMs(start, label);
  return { startMs, endMs: startMs + requirePositive(durationS, `${label} durationS`) * MS_PER_SECOND };
}

function requireSourceKey(site: SiteDef, sourceKey: string): string {
  const known = site.assets.some((a) => a.points.some((p) => p.sourceKey === sourceKey)) || site.unmappedTags.some((t) => t.sourceKey === sourceKey);
  if (!known) throw new Error(`${site.code}에 없는 원본 태그: ${sourceKey}`);
  return sourceKey;
}

function resolveDetector(site: SiteDef, detector: string | undefined): string {
  const detectors = site.assets.filter((a) => a.classKey === 'h2.detector');
  const chosen = detector === undefined ? (detectors.find((a) => a.nameplate.location === 'H2BANK1') ?? detectors[0]) : detectors.find((a) => a.code === detector);
  if (!chosen) throw new Error(`${site.code}에 수소 검지기가 없거나 코드가 틀립니다: ${detector ?? '(기본)'}`);
  return chosen.code;
}

function validateFault(site: SiteDef, fault: FaultScenario): FaultScenario {
  if (site.attributes.control_group === true) throw new Error(`${site.code}는 고장 주입을 하지 않는 대조군입니다`);
  const spec = DEGRADATION_PARAMS[fault.param];
  if (!spec) throw new Error(`알 수 없는 열화 파라미터: ${String(fault.param)}`);
  const candidates: readonly AssetDef[] = site.assets.filter((a) => a.classKey === spec.classKey);
  const matches = fault.asset === undefined ? candidates : candidates.filter((a) => a.code === fault.asset);
  if (matches.length === 0) throw new Error(`${site.code}에 ${fault.param}을(를) 적용할 ${spec.classKey} 설비가 없습니다: ${fault.asset ?? '(전체)'}`);
  return fault;
}

function applyScenario(plan: SiteScenarioPlan, site: SiteDef, scenario: Exclude<Scenario, HealthyScenario>): SiteScenarioPlan {
  const label = `${scenario.kind}(${site.code})`;
  switch (scenario.kind) {
    case 'dq.gateway_outage':
      return { ...plan, outages: [...plan.outages, windowOf(scenario.start, scenario.durationS, label)] };
    case 'dq.duplicate_batches':
      if (!(scenario.ratio >= 0 && scenario.ratio <= 1)) throw new Error(`${label} ratio는 0~1: ${scenario.ratio}`);
      return { ...plan, duplicateRatio: scenario.ratio };
    case 'dq.stuck_sensor':
      return { ...plan, stuckSensors: [...plan.stuckSensors, { ...windowOf(scenario.start, scenario.durationS, label), sourceKey: requireSourceKey(site, scenario.sourceKey) }] };
    case 'dq.spike':
      return {
        ...plan,
        spikes: [...plan.spikes, { sourceKey: requireSourceKey(site, scenario.sourceKey), perDay: requirePositive(scenario.perDay, `${label} perDay`), magnitude: requirePositive(scenario.magnitude ?? DEFAULT_SPIKE_MAGNITUDE, `${label} magnitude`) }],
      };
    case 'dq.clock_skew':
      if (!Number.isFinite(scenario.skewS)) throw new Error(`${label} skewS가 올바르지 않습니다`);
      return { ...plan, clockSkewMs: Math.round(scenario.skewS * MS_PER_SECOND) };
    case 'safety.h2_leak_alarm':
      return { ...plan, leakAlarms: [...plan.leakAlarms, { atMs: toEpochMs(scenario.at, label), detector: resolveDetector(site, scenario.detector) }] };
    case 'fault':
      return { ...plan, faults: [...plan.faults, validateFault(site, scenario)] };
  }
}

/** 시나리오를 검증하고 사이트별 계획으로 모은다. 모르는 사이트를 가리키면 오류. */
export function planScenarios(sites: readonly SiteDef[], scenarios: readonly Scenario[]): ReadonlyMap<string, SiteScenarioPlan> {
  const plans = new Map<string, SiteScenarioPlan>(sites.map((s) => [s.code, EMPTY_PLAN]));
  for (const scenario of scenarios) {
    if (scenario.kind === 'healthy') continue;
    const site = sites.find((s) => s.code === scenario.site);
    const current = plans.get(scenario.site);
    if (!site || !current) throw new Error(`시뮬레이션 대상이 아닌 사이트의 시나리오: ${scenario.kind} → ${scenario.site}`);
    plans.set(site.code, applyScenario(current, site, scenario));
  }
  return plans;
}

export interface DegradationResolver {
  value(param: DegradationParam, assetCode: string, tMs: number): number;
}

/** 설비 지정 hook > 사이트 전체 hook > 기본값. 같은 대상이 여럿이면 나중 것이 이긴다. */
export function createDegradationResolver(faults: readonly FaultScenario[]): DegradationResolver {
  return {
    value(param, assetCode, tMs) {
      const baseline = DEGRADATION_PARAMS[param].baseline;
      const hook =
        faults.findLast((f) => f.param === param && f.asset === assetCode) ??
        faults.findLast((f) => f.param === param && f.asset === undefined);
      if (!hook) return baseline;
      const value = hook.value(tMs, baseline);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${param}(${assetCode}) hook이 잘못된 값을 돌려줬습니다: ${value}`);
      return value;
    },
  };
}
