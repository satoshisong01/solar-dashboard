// 정답 기록: 실행에 넣은 고장·데이터 품질 주입, 오탐 판정용 대조군 이벤트, asset_event로 넣을 운영 이벤트.
// 시나리오 → 계획(planScenarios)과 같은 해석을 거치므로 시뮬레이션 출력과 어긋나지 않는다.
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { socMaxAt, type ControlKind, type ControlPlan } from './control-scenarios';
import { DEGRADATION_PARAMS, type DegradationParam, type FaultScenario } from './degradation';
import { isTypedFault, resolveFault, type TypedFaultKind } from './fault-scenarios';
import { toEpochMs, type TimeInput } from './math';
import { planScenarios, scenarioOriginMs, type Scenario, type SiteScenarioPlan } from './scenarios';

export type TruthParams = Readonly<Record<string, number | string>>;

/** sim.injection 한 행 */
export interface InjectionTruth {
  readonly siteCode: string;
  /** `${사이트}/${설비 코드}`. null = 사이트·게이트웨이 단위 */
  readonly assetPath: string | null;
  readonly kind: string;
  readonly startTs: number;
  /** 고장은 실행 끝까지 지속 (실행 종료 시각). 순간 이벤트는 null */
  readonly endTs: number | null;
  readonly params: TruthParams;
  readonly expectedFailureModes: readonly string[];
  /** 이 주입을 잡아야 하는 탐지기 (설계 §5.3 탐지기 id). 없으면 탐지기 평가 대상 아님 */
  readonly expectedDetectors: readonly string[];
}

/** 고장이 아닌 조건. 이 구간·설비에서 나온 해당 탐지기 finding은 오탐으로 본다. */
export interface ControlEventTruth {
  readonly siteCode: string;
  readonly assetPath: string | null;
  readonly kind: ControlKind;
  readonly startTs: number;
  readonly endTs: number;
  readonly params: TruthParams;
  /** 이 조건에 속기 쉬운 탐지기 */
  readonly confoundedDetectors: readonly string[];
}

/** om.asset_event로 넣어야 할 운영 이벤트 */
export interface AssetEventTruth {
  readonly siteCode: string;
  readonly assetPath: string;
  readonly ts: number;
  readonly kind: 'setpoint_change' | 'replacement';
  readonly resetsBaseline: boolean;
  readonly note: string;
}

export interface SimulationTruth {
  readonly fromMs: number;
  readonly toMs: number;
  /** 일수 기반 시나리오의 0일째 */
  readonly originMs: number;
  readonly injections: readonly InjectionTruth[];
  readonly controls: readonly ControlEventTruth[];
  readonly assetEvents: readonly AssetEventTruth[];
}

export interface TruthOptions {
  readonly siteCodes: readonly string[];
  readonly from: TimeInput;
  readonly to: TimeInput;
  readonly scenarios: readonly Scenario[];
}

interface Expectation {
  readonly failureModes: readonly string[];
  readonly detectors: readonly string[];
}

const TYPED_FAULT_EXPECTATION: Readonly<Record<TypedFaultKind, Expectation>> = {
  'fault.battery_capacity_fade': { failureModes: ['capacity_fade'], detectors: ['ess.capacity_fade'] },
  'fault.cell_imbalance': { failureModes: ['cell_imbalance'], detectors: ['ess.cell_imbalance'] },
  'fault.inverter_efficiency_drop': { failureModes: ['inverter_efficiency_drop'], detectors: ['pv.inverter_peer'] },
  'fault.elz_stack_degradation': { failureModes: ['stack_voltage_rise'], detectors: ['el.voltage_rise'] },
  'fault.fc_voltage_decay': { failureModes: ['stack_voltage_decay'], detectors: ['fc.voltage_decay'] },
};

/** 원시 hook(kind 'fault')은 파라미터로 고장모드를 정한다. P3 탐지기 대상은 탐지기 목록을 비워 둔다. */
const PARAM_EXPECTATION: Readonly<Record<DegradationParam, Expectation>> = {
  'battery.capacityFadePerDay': TYPED_FAULT_EXPECTATION['fault.battery_capacity_fade'],
  'battery.cellImbalance': TYPED_FAULT_EXPECTATION['fault.cell_imbalance'],
  'battery.cellSpreadMv': TYPED_FAULT_EXPECTATION['fault.cell_imbalance'],
  'inverter.efficiencyDrop': TYPED_FAULT_EXPECTATION['fault.inverter_efficiency_drop'],
  'elz.degradationUvPerH': TYPED_FAULT_EXPECTATION['fault.elz_stack_degradation'],
  'fc.voltageDecayUvPerH': TYPED_FAULT_EXPECTATION['fault.fc_voltage_decay'],
  'storage.leakKgPerDay': { failureModes: ['storage_leak'], detectors: [] },
  'pv.soilingPerDay': { failureModes: ['soiling'], detectors: [] },
  'blower.wear': { failureModes: ['blower_wear'], detectors: [] },
};

const CONFOUNDED: Readonly<Record<ControlKind, readonly string[]>> = {
  'control.cold_week': ['ess.capacity_fade', 'el.voltage_rise'],
  'control.cloudy_week': ['pv.inverter_peer', 'ess.capacity_fade', 'el.voltage_rise'],
  'control.curtailment': ['pv.inverter_peer'],
  'control.elz_part_load_week': ['el.voltage_rise'],
  'control.fc_frequent_start_stop': ['fc.voltage_decay'],
  'control.soc_upper_limit_change': ['ess.capacity_fade'],
};

const pathOf = (site: SiteDef, assetCode: string): string => `${site.code}/${assetCode}`;
const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

function findSites(codes: readonly string[]): readonly SiteDef[] {
  return codes.map((code) => {
    const site = SIM_SITES.find((s) => s.code === code);
    if (!site) throw new Error(`알 수 없는 가상 사이트: ${code}`);
    return site;
  });
}

interface RunWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly originMs: number;
}

function rawFaultTruth(site: SiteDef, fault: FaultScenario, { fromMs, toMs }: RunWindow): InjectionTruth[] {
  const classKey = DEGRADATION_PARAMS[fault.param].classKey;
  const expectation = PARAM_EXPECTATION[fault.param];
  return site.assets
    .filter((a) => a.classKey === classKey && (fault.asset === undefined || a.code === fault.asset))
    .map((asset) => ({
      siteCode: site.code,
      assetPath: pathOf(site, asset.code),
      kind: fault.kind,
      startTs: fromMs,
      endTs: toMs,
      params: { param: fault.param },
      expectedFailureModes: expectation.failureModes,
      expectedDetectors: expectation.detectors,
    }));
}

function faultTruths(sites: readonly SiteDef[], scenarios: readonly Scenario[], run: RunWindow): InjectionTruth[] {
  return scenarios.flatMap((scenario): InjectionTruth[] => {
    const site = 'site' in scenario ? sites.find((s) => s.code === scenario.site) : undefined;
    if (!site) return [];
    if (scenario.kind === 'fault') return rawFaultTruth(site, scenario, run);
    if (!isTypedFault(scenario)) return [];
    const resolved = resolveFault(site, scenario, run.originMs);
    const expectation = TYPED_FAULT_EXPECTATION[scenario.kind];
    return [{
      siteCode: site.code,
      assetPath: pathOf(site, resolved.assetCode),
      kind: scenario.kind,
      startTs: Math.max(resolved.startMs, run.fromMs),
      endTs: run.toMs,
      params: { ...resolved.params, fullEffectTs: resolved.fullEffectMs },
      expectedFailureModes: expectation.failureModes,
      expectedDetectors: expectation.detectors,
    }];
  });
}

function assetPathOfSource(site: SiteDef, sourceKey: string): string | null {
  const asset = site.assets.find((a) => a.points.some((p) => p.sourceKey === sourceKey));
  const tag = site.unmappedTags.find((t) => t.sourceKey === sourceKey);
  const code = asset?.code ?? tag?.assetCode;
  return code === undefined ? null : pathOf(site, code);
}

/** 데이터 품질·안전 주입 (게이트웨이 단절·센서 고착·스파이크·시계 오차·누출 경보) */
function dqTruths(site: SiteDef, plan: SiteScenarioPlan, { fromMs, toMs }: RunWindow): InjectionTruth[] {
  const base: Pick<InjectionTruth, 'siteCode' | 'expectedDetectors'> = { siteCode: site.code, expectedDetectors: [] };
  return [
    ...plan.outages.map((w): InjectionTruth => ({ ...base, assetPath: null, kind: 'dq.gateway_outage', startTs: w.startMs, endTs: w.endMs, params: {}, expectedFailureModes: ['comm_outage'] })),
    ...plan.stuckSensors.map((w): InjectionTruth => ({
      ...base,
      assetPath: assetPathOfSource(site, w.sourceKey),
      kind: 'dq.stuck_sensor',
      startTs: w.startMs,
      endTs: w.endMs,
      params: { sourceKey: w.sourceKey },
      expectedFailureModes: ['sensor_flatline'],
      expectedDetectors: ['dq.gap_flatline'],
    })),
    ...plan.spikes.map((s): InjectionTruth => ({ ...base, assetPath: assetPathOfSource(site, s.sourceKey), kind: 'dq.spike', startTs: fromMs, endTs: toMs, params: { sourceKey: s.sourceKey, perDay: s.perDay, magnitude: s.magnitude }, expectedFailureModes: ['sensor_spike'] })),
    ...(plan.clockSkewMs === 0
      ? []
      : [{ ...base, assetPath: null, kind: 'dq.clock_skew' as const, startTs: plan.clockSkewWindow?.startMs ?? fromMs, endTs: plan.clockSkewWindow?.endMs ?? toMs, params: { skewMs: plan.clockSkewMs }, expectedFailureModes: ['clock_skew'] }]),
    ...plan.leakAlarms.map((a): InjectionTruth => ({ ...base, assetPath: pathOf(site, a.detector), kind: 'safety.h2_leak_alarm', startTs: a.atMs, endTs: null, params: {}, expectedFailureModes: ['h2_leak'] })),
  ];
}

function controlTruths(site: SiteDef, plan: ControlPlan, toMs: number): ControlEventTruth[] {
  const siteWide = (kind: ControlKind, startMs: number, endMs: number, params: TruthParams): ControlEventTruth => ({
    siteCode: site.code,
    assetPath: null,
    kind,
    startTs: startMs,
    endTs: Math.min(endMs, toMs),
    params,
    confoundedDetectors: CONFOUNDED[kind],
  });
  return [
    ...plan.coldWeeks.map((w) => siteWide('control.cold_week', w.startMs, w.endMs, { ambientDeltaC: w.ambientDeltaC, roomDeltaC: w.roomDeltaC })),
    ...plan.cloudyWeeks.map((w) => siteWide('control.cloudy_week', w.startMs, w.endMs, { cloudMin: w.cloudMin })),
    ...plan.curtailments.map((w) => siteWide('control.curtailment', w.startMs, w.endMs, { limitPct: w.limitPct })),
    ...plan.elzPartLoads.map((w) => siteWide('control.elz_part_load_week', w.startMs, w.endMs, { maxLoadFraction: w.maxLoadFraction })),
    ...plan.fcStartStops.map((w) => siteWide('control.fc_frequent_start_stop', w.startMs, w.endMs, {})),
    ...plan.socLimitChanges.map((c): ControlEventTruth => ({
      ...siteWide('control.soc_upper_limit_change', c.atMs, toMs, { previousLimit: socMaxAt(plan, c.atMs - 1), newLimit: c.newLimit }),
      assetPath: pathOf(site, c.assetCode),
    })),
  ];
}

function assetEventTruths(site: SiteDef, plan: ControlPlan): AssetEventTruth[] {
  return plan.socLimitChanges.map((c) => ({
    siteCode: site.code,
    assetPath: pathOf(site, c.assetCode),
    ts: c.atMs,
    kind: 'setpoint_change',
    // 기준선 분할은 관리자가 기각 사유("운영 조건 변경")로 정한다. 운영 기록만 남긴다.
    resetsBaseline: false,
    note: `EMS 충전 SOC 상한 ${percent(socMaxAt(plan, c.atMs - 1))} → ${percent(c.newLimit)}`,
  }));
}

/** 실행 구간이 끝난 뒤에 시작하는 주입·대조군은 출력에 흔적이 없어 정답으로 쓸 수 없다. */
function assertStartsInRun(records: readonly { readonly kind: string; readonly siteCode: string; readonly startTs: number }[], toMs: number): void {
  const late = records.find((r) => r.startTs >= toMs);
  if (late) throw new Error(`${late.kind}(${late.siteCode}) 시작 시각이 실행 구간 밖입니다: ${new Date(late.startTs).toISOString()}`);
}

/** 실행 설정으로 정답을 만든다. simulate·simulateMemory와 같은 실행 기준일(scenarioOriginMs(from))을 쓴다. */
export function buildTruth(options: TruthOptions): SimulationTruth {
  const fromMs = toEpochMs(options.from, 'from');
  const toMs = toEpochMs(options.to, 'to');
  if (toMs <= fromMs) throw new Error('to는 from보다 늦어야 합니다');
  const run: RunWindow = { fromMs, toMs, originMs: scenarioOriginMs(fromMs) };
  const sites = findSites(options.siteCodes);
  const plans = planScenarios(sites, options.scenarios, { originMs: run.originMs });
  const perSite = sites.flatMap((site) => {
    const plan = plans.get(site.code);
    return plan ? [{ site, plan }] : [];
  });
  const injections = [...faultTruths(sites, options.scenarios, run), ...perSite.flatMap(({ site, plan }) => dqTruths(site, plan, run))];
  const controls = perSite.flatMap(({ site, plan }) => controlTruths(site, plan, toMs));
  assertStartsInRun([...injections, ...controls], toMs);
  return { ...run, injections, controls, assetEvents: perSite.flatMap(({ site, plan }) => assetEventTruths(site, plan)) };
}
