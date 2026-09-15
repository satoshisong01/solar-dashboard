// P3 정답: 고장 주입(기대 고장모드·탐지기·부수 탐지기), 대조군 이벤트(속기 쉬운 탐지기), 운영 이벤트(모듈 세척·필터 교체).
// 고장모드 키는 lib/analytics/detectors/types.ts FailureMode, 탐지기 id는 설계 §5.3 P3 탐지기 이름과 같다.
import type { SiteDef } from '@/db/seed/types';
import { P3_CONTROL_SETTINGS, type P3ControlKind } from './control-scenarios-p3';
import type { DegradationParam } from './degradation';
import { resolveP3Fault, type P3FaultKind, type P3FaultScenario } from './fault-scenarios-p3';
import type { SiteScenarioPlan } from './scenarios';
import type { AssetEventTruth, ControlEventTruth, InjectionTruth, TruthParams } from './truth';

export interface P3Expectation {
  readonly failureModes: readonly string[];
  readonly detectors: readonly string[];
  /** 이 고장이 함께 일으킬 수 있는 다른 탐지기 finding (오탐으로 세지 않고 재현율에도 넣지 않는다) */
  readonly related: readonly string[];
}

const TANK_LEAK: P3Expectation = { failureModes: ['h2.storage_leak'], detectors: ['tank.static_leak'], related: ['h2chain.mass_balance_gap'] };
const FLOW_DRIFT: P3Expectation = { failureModes: ['h2chain.mass_balance_gap'], detectors: ['h2chain.mass_balance_gap'], related: [] };
const SEC_RISE: P3Expectation = { failureModes: ['el.system_efficiency_loss'], detectors: ['el.sec_rise'], related: [] };
const COMPRESSOR: P3Expectation = { failureModes: ['comp.efficiency_loss'], detectors: ['comp.sec_rise'], related: [] };
const SEAL_LEAK: P3Expectation = { failureModes: ['comp.efficiency_loss'], detectors: ['comp.sec_rise'], related: ['h2chain.mass_balance_gap'] };
const BLOWER: P3Expectation = { failureModes: ['fc.blower_wear'], detectors: ['fc.blower_wear'], related: [] };
const SOILING: P3Expectation = { failureModes: ['pv.soiling'], detectors: ['pv.soiling_rate'], related: [] };
const RESISTANCE: P3Expectation = { failureModes: ['ess.resistance_growth'], detectors: ['ess.resistance_growth'], related: ['ess.capacity_fade'] };
const FAN_FAILURE: P3Expectation = { failureModes: ['pv.inverter_thermal_derating'], detectors: ['inv.thermal_derating'], related: ['pv.inverter_peer'] };

export const P3_FAULT_EXPECTATION: Readonly<Record<P3FaultKind, P3Expectation>> = {
  'fault.tank_leak': TANK_LEAK,
  'fault.flowmeter_drift': FLOW_DRIFT,
  'fault.elz_sec_rise': SEC_RISE,
  'fault.compressor_valve_wear': COMPRESSOR,
  'fault.compressor_leak_seal': SEAL_LEAK,
  'fault.fc_blower_wear': BLOWER,
  'fault.fc_air_filter_clog': BLOWER,
  'fault.pv_soiling': SOILING,
  'fault.rack_resistance_growth': RESISTANCE,
  'fault.inverter_fan_failure': FAN_FAILURE,
};

/** 원시 hook(kind 'fault')의 P3 파라미터 → 고장모드·탐지기 */
export const P3_PARAM_EXPECTATION: Readonly<Partial<Record<DegradationParam, P3Expectation>>> = {
  'storage.leakKgPerDay': TANK_LEAK,
  'pv.soilingPerDay': { failureModes: ['pv.soiling'], detectors: [], related: [] },
  'blower.wear': BLOWER,
  'pv.stickySoilingPerDay': SOILING,
  'inverter.coolingLoss': FAN_FAILURE,
  'battery.resistanceGrowth': RESISTANCE,
  'elz.rectifierLossExtra': SEC_RISE,
  'elz.faradaicLoss': SEC_RISE,
  'elz.extraCellVoltageV': SEC_RISE,
  'meter.h2FlowGain': FLOW_DRIFT,
  'compressor.valveWear': COMPRESSOR,
  'compressor.sealLeakBar': SEAL_LEAK,
  'blower.filterClog': BLOWER,
};

/** 셀 전압 경로의 비에너지 상승은 스택 전압 상승 탐지기(el.voltage_rise)도 함께 잡을 수 있다 */
function expectationOf(fault: P3FaultScenario): P3Expectation {
  const base = P3_FAULT_EXPECTATION[fault.kind];
  return fault.kind === 'fault.elz_sec_rise' && fault.mode === 'stack' ? { ...base, related: [...base.related, 'el.voltage_rise'] } : base;
}

export interface RunBounds {
  readonly fromMs: number;
  readonly toMs: number;
  readonly originMs: number;
}

const pathOf = (site: SiteDef, assetCode: string): string => `${site.code}/${assetCode}`;

/** 오염 고장의 복원 시각: 시작 뒤 강한 비(고장 강우일·비 오는 주)와 모듈 세척 */
function soilingRestorations(plan: SiteScenarioPlan, startMs: number, toMs: number): TruthParams {
  const rains = plan.rainWindows.filter((w) => w.endMs > startMs && w.startMs < toMs).map((w) => w.startMs);
  const cleanings = plan.pvCleanings.filter((c) => c.atMs >= startMs && c.atMs < toMs).map((c) => c.atMs);
  return { restoreTs: [...new Set([...rains, ...cleanings])].sort((a, b) => a - b).join(',') };
}

export function p3FaultTruths(site: SiteDef, plan: SiteScenarioPlan, fault: P3FaultScenario, run: RunBounds): InjectionTruth[] {
  const resolved = resolveP3Fault(site, fault, run.originMs);
  const expectation = expectationOf(fault);
  const extra = fault.kind === 'fault.pv_soiling' ? soilingRestorations(plan, resolved.startMs, run.toMs) : {};
  return resolved.assetCodes.map((code) => ({
    siteCode: site.code,
    assetPath: pathOf(site, code),
    kind: fault.kind,
    startTs: Math.max(resolved.startMs, run.fromMs),
    endTs: resolved.recoveredMs === null ? run.toMs : Math.min(resolved.recoveredMs, run.toMs),
    params: { ...resolved.params, ...extra, fullEffectTs: resolved.fullEffectMs },
    expectedFailureModes: expectation.failureModes,
    expectedDetectors: expectation.detectors,
    ...(expectation.related.length > 0 ? { relatedDetectors: expectation.related } : {}),
  }));
}

export const P3_CONFOUNDED: Readonly<Record<P3ControlKind, readonly string[]>> = {
  'control.hot_week': ['inv.thermal_derating', 'fc.blower_wear', 'pv.soiling_rate', 'pv.inverter_peer'],
  'control.rainy_week': ['pv.soiling_rate', 'pv.inverter_peer'],
  'control.day_night_swing': ['tank.static_leak', 'h2chain.mass_balance_gap'],
  'control.tank_refill_topoff': ['tank.static_leak', 'h2chain.mass_balance_gap'],
  'control.compressor_high_ratio_week': ['comp.sec_rise'],
  'control.healthy_mass_balance': ['h2chain.mass_balance_gap', 'tank.static_leak'],
};

const codeOfClass = (site: SiteDef, classKey: string): string | null => site.assets.find((a) => a.classKey === classKey)?.code ?? null;

export function p3ControlTruths(site: SiteDef, plan: SiteScenarioPlan, toMs: number): ControlEventTruth[] {
  const at = (kind: P3ControlKind, classKey: string | null, startMs: number, endMs: number, params: TruthParams): ControlEventTruth => {
    const code = classKey === null ? null : codeOfClass(site, classKey);
    return { siteCode: site.code, assetPath: code === null ? null : pathOf(site, code), kind, startTs: startMs, endTs: Math.min(endMs, toMs), params, confoundedDetectors: P3_CONFOUNDED[kind] };
  };
  return [
    ...plan.hotWeeks.map((w) => at('control.hot_week', null, w.startMs, w.endMs, { ambientDeltaC: w.ambientDeltaC })),
    ...plan.rainyWeeks.map((w) => at('control.rainy_week', null, w.startMs, w.endMs, { heavyRainWindows: plan.rainWindows.filter((r) => r.startMs >= w.startMs && r.startMs < w.endMs).length })),
    ...plan.tankSwings.map((w) => at('control.day_night_swing', 'h2.storage.bank', w.startMs, w.endMs, { amplitudeC: w.amplitudeC })),
    ...plan.topoffWeeks.map((w) => at('control.tank_refill_topoff', 'h2.storage.bank', w.startMs, w.endMs, { nightlyRuns: plan.topoffs.filter((t) => t.startMs >= w.startMs && t.startMs < w.endMs).length })),
    ...plan.highRatioWeeks.map((w) => at('control.compressor_high_ratio_week', 'h2.compressor', w.startMs, w.endMs, { suctionBar: w.suctionBar })),
    ...plan.healthyBalances.map((w) => at('control.healthy_mass_balance', null, w.startMs, w.endMs, { maxResidualPct: P3_CONTROL_SETTINGS.healthyMassBalance.maxResidualPct })),
  ];
}

export function p3AssetEventTruths(site: SiteDef, plan: SiteScenarioPlan): AssetEventTruth[] {
  return [
    // 기준선 분할은 관리자가 정한다. 운영 기록만 남긴다.
    ...plan.pvCleanings.map((c): AssetEventTruth => ({ siteCode: site.code, assetPath: pathOf(site, c.assetCode), ts: c.atMs, kind: 'maintenance', resetsBaseline: false, note: '태양광 모듈 세척' })),
    ...plan.filterReplacements.map((r): AssetEventTruth => ({ siteCode: site.code, assetPath: pathOf(site, r.assetCode), ts: r.atMs, kind: 'replacement', resetsBaseline: false, note: '연료전지 공기 필터 교체' })),
  ];
}
