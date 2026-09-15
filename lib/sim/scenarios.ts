// 시뮬레이션 시나리오 타입과 적용기.
// P1: healthy · 데이터 품질(dq.*) · 안전 경보 · 열화 파라미터 hook(fault).
// P2: 고장(fault.*, fault-scenarios.ts) · 음성 대조군(control.*, control-scenarios.ts). 일수 기반이라 실행 기준일이 필요하다.
// P3: 수소 저장·압축기·BoP·태양광 오염 고장(fault-scenarios-p3.ts) · 대조군(control-scenarios-p3.ts).
import type { AssetDef, SiteDef } from '@/db/seed/types';
import { applyControl, EMPTY_CONTROL_PLAN, isControl, type ControlPlan, type ControlScenario } from './control-scenarios';
import { applyP3Control, EMPTY_P3_CONTROL_PLAN, EMPTY_P3_EVENT_PLAN, isP3Control, type P3ControlPlan, type P3ControlScenario, type P3EventPlan } from './control-scenarios-p3';
import { isP3Fault, resolveP3Fault, type P3FaultScenario } from './fault-scenarios-p3';
import { DEGRADATION_PARAMS, type FaultScenario } from './degradation';
import { isTypedFault, resolveFault, type TypedFaultScenario } from './fault-scenarios';
import { kstDayStartMs, MS_PER_SECOND, toEpochMs, type TimeInput, type TimeWindow } from './math';

export { createDegradationResolver, DEGRADATION_PARAMS } from './degradation';
export type { DegradationHook, DegradationParam, DegradationResolver, FaultScenario } from './degradation';
export type { TimeWindow } from './math';

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
/** 센서 샘플이 영영 들어오지 않음 (게이트웨이가 그 태그를 보내지 못함). 단절 후 백필과 달리 저장값에 결측이 남는다 */
export interface SampleLossScenario {
  readonly kind: 'dq.sample_loss';
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
  /** 게이트웨이 시계 오차 [초] (+면 빠름) */
  readonly skewS: number;
  /** 오차 구간 시작. start·durationS를 생략하면 실행 내내 일정한 오차 */
  readonly start?: TimeInput;
  readonly durationS?: number;
}
export interface H2LeakAlarmScenario {
  readonly kind: 'safety.h2_leak_alarm';
  readonly site: string;
  readonly at: TimeInput;
  /** 수소 검지기 설비 코드. 생략하면 저장뱅크(H2BANK1) 위치 검지기 */
  readonly detector?: string;
}
export type Scenario =
  | HealthyScenario
  | GatewayOutageScenario
  | DuplicateBatchesScenario
  | StuckSensorScenario
  | SampleLossScenario
  | SpikeScenario
  | ClockSkewScenario
  | H2LeakAlarmScenario
  | FaultScenario
  | TypedFaultScenario
  | ControlScenario
  | P3FaultScenario
  | P3ControlScenario;

export interface SiteScenarioPlan extends ControlPlan, P3ControlPlan, P3EventPlan {
  readonly outages: readonly TimeWindow[];
  readonly duplicateRatio: number;
  readonly clockSkewMs: number;
  /** clockSkewMs를 적용하는 전송 시각 구간. null이면 실행 내내 */
  readonly clockSkewWindow: TimeWindow | null;
  readonly stuckSensors: readonly (TimeWindow & { readonly sourceKey: string })[];
  readonly sampleLosses: readonly (TimeWindow & { readonly sourceKey: string })[];
  readonly spikes: readonly { readonly sourceKey: string; readonly perDay: number; readonly magnitude: number }[];
  readonly leakAlarms: readonly { readonly atMs: number; readonly detector: string }[];
  readonly faults: readonly FaultScenario[];
}

export const EMPTY_PLAN: SiteScenarioPlan = Object.freeze({
  outages: [],
  duplicateRatio: 0,
  clockSkewMs: 0,
  clockSkewWindow: null,
  stuckSensors: [],
  sampleLosses: [],
  spikes: [],
  leakAlarms: [],
  faults: [],
  ...EMPTY_CONTROL_PLAN,
  ...EMPTY_P3_CONTROL_PLAN,
  ...EMPTY_P3_EVENT_PLAN,
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

function requireOrigin(originMs: number | undefined, label: string): number {
  if (originMs === undefined || !Number.isFinite(originMs)) throw new Error(`${label}: 일수 기반 시나리오에는 실행 기준일(originMs)이 필요합니다`);
  return originMs;
}

function applyScenario(plan: SiteScenarioPlan, site: SiteDef, scenario: Exclude<Scenario, HealthyScenario>, originMs: number | undefined): SiteScenarioPlan {
  const label = `${scenario.kind}(${site.code})`;
  if (isTypedFault(scenario)) {
    const { hook } = resolveFault(site, scenario, requireOrigin(originMs, label));
    return { ...plan, faults: [...plan.faults, validateFault(site, hook)] };
  }
  if (isControl(scenario)) return applyControl(plan, site, scenario, requireOrigin(originMs, label));
  if (isP3Fault(scenario)) return applyP3Fault(plan, site, scenario, requireOrigin(originMs, label));
  if (isP3Control(scenario)) return applyP3Control(plan, site, scenario, requireOrigin(originMs, label));
  switch (scenario.kind) {
    case 'dq.gateway_outage':
      return { ...plan, outages: [...plan.outages, windowOf(scenario.start, scenario.durationS, label)] };
    case 'dq.duplicate_batches':
      if (!(scenario.ratio >= 0 && scenario.ratio <= 1)) throw new Error(`${label} ratio는 0~1: ${scenario.ratio}`);
      return { ...plan, duplicateRatio: scenario.ratio };
    case 'dq.stuck_sensor':
      return { ...plan, stuckSensors: [...plan.stuckSensors, { ...windowOf(scenario.start, scenario.durationS, label), sourceKey: requireSourceKey(site, scenario.sourceKey) }] };
    case 'dq.sample_loss':
      return { ...plan, sampleLosses: [...plan.sampleLosses, { ...windowOf(scenario.start, scenario.durationS, label), sourceKey: requireSourceKey(site, scenario.sourceKey) }] };
    case 'dq.spike':
      return {
        ...plan,
        spikes: [...plan.spikes, { sourceKey: requireSourceKey(site, scenario.sourceKey), perDay: requirePositive(scenario.perDay, `${label} perDay`), magnitude: requirePositive(scenario.magnitude ?? DEFAULT_SPIKE_MAGNITUDE, `${label} magnitude`) }],
      };
    case 'dq.clock_skew': {
      if (!Number.isFinite(scenario.skewS)) throw new Error(`${label} skewS가 올바르지 않습니다`);
      if ((scenario.start === undefined) !== (scenario.durationS === undefined)) throw new Error(`${label} start와 durationS는 함께 지정해야 합니다`);
      const window = scenario.start === undefined || scenario.durationS === undefined ? null : windowOf(scenario.start, scenario.durationS, label);
      return { ...plan, clockSkewMs: Math.round(scenario.skewS * MS_PER_SECOND), clockSkewWindow: window };
    }
    case 'safety.h2_leak_alarm':
      return { ...plan, leakAlarms: [...plan.leakAlarms, { atMs: toEpochMs(scenario.at, label), detector: resolveDetector(site, scenario.detector) }] };
    case 'fault':
      return { ...plan, faults: [...plan.faults, validateFault(site, scenario)] };
  }
}

function applyP3Fault(plan: SiteScenarioPlan, site: SiteDef, fault: P3FaultScenario, originMs: number): SiteScenarioPlan {
  const resolved = resolveP3Fault(site, fault, originMs);
  return {
    ...plan,
    faults: [...plan.faults, ...resolved.hooks.map((hook) => validateFault(site, hook))],
    rainWindows: [...plan.rainWindows, ...resolved.events.rainWindows],
    pvCleanings: [...plan.pvCleanings, ...resolved.events.pvCleanings],
    filterReplacements: [...plan.filterReplacements, ...resolved.events.filterReplacements],
  };
}

/** 건강한 물질수지 확인 구간은 고장이 없는 사이트에만 둘 수 있다 */
function assertHealthyBalance(site: SiteDef, plan: SiteScenarioPlan): void {
  if (plan.healthyBalances.length > 0 && plan.faults.length > 0) throw new Error(`control.healthy_mass_balance(${site.code}): 고장이 주입된 사이트에는 쓸 수 없습니다`);
}

/** 이 태그의 이 시각 샘플이 결측 주입 구간이면 true (보내지도 저장하지도 않는다) */
export function isSampleLost(plan: Pick<SiteScenarioPlan, 'sampleLosses'>, sourceKey: string, tMs: number): boolean {
  return plan.sampleLosses.some((w) => w.sourceKey === sourceKey && tMs >= w.startMs && tMs < w.endMs);
}

/** 그 시각에 보내는 배치에 적용할 게이트웨이 시계 오차 [ms] */
export function clockSkewAt(plan: Pick<SiteScenarioPlan, 'clockSkewMs' | 'clockSkewWindow'>, sentAtMs: number): number {
  const window = plan.clockSkewWindow;
  if (window === null) return plan.clockSkewMs;
  return sentAtMs >= window.startMs && sentAtMs < window.endMs ? plan.clockSkewMs : 0;
}

/** 실행 기준일: 실행 시작 시각이 속한 KST 날짜 0시. 일수 기반 시나리오(fault.* · control.*)의 0일째 */
export const scenarioOriginMs = (from: TimeInput): number => kstDayStartMs(toEpochMs(from, 'from'));

export interface PlanOptions {
  /** 일수 기반 시나리오의 기준 시각 (보통 scenarioOriginMs(실행 시작)) */
  readonly originMs?: number;
}

/** 시나리오를 검증하고 사이트별 계획으로 모은다. 모르는 사이트를 가리키면 오류. */
export function planScenarios(sites: readonly SiteDef[], scenarios: readonly Scenario[], options: PlanOptions = {}): ReadonlyMap<string, SiteScenarioPlan> {
  const plans = new Map<string, SiteScenarioPlan>(sites.map((s) => [s.code, EMPTY_PLAN]));
  for (const scenario of scenarios) {
    if (scenario.kind === 'healthy') continue;
    const site = sites.find((s) => s.code === scenario.site);
    const current = plans.get(scenario.site);
    if (!site || !current) throw new Error(`시뮬레이션 대상이 아닌 사이트의 시나리오: ${scenario.kind} → ${scenario.site}`);
    plans.set(site.code, applyScenario(current, site, scenario, options.originMs));
  }
  for (const site of sites) assertHealthyBalance(site, plans.get(site.code) ?? EMPTY_PLAN);
  return plans;
}
