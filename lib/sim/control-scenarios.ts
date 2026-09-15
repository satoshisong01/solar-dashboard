// 음성 대조군 시나리오 (P2): 고장이 아닌데 탐지기가 속기 쉬운 운전·기상 조건.
// startDay/day는 실행 기준일(실행 시작 시각이 속한 KST 날짜 0시)부터 센 일수다.
import type { SiteDef } from '@/db/seed/types';
import { EMS_SETTINGS } from './ems';
import { edgeRampFraction, isInWindow, MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from './math';
import type { WeatherWindow } from './weather';

export const CONTROL_SETTINGS = Object.freeze({
  /** 한파 주간: 외기 −10 °C, 공조 난방 부족으로 배터리실 −4 °C (양끝 12시간 램프) */
  coldWeek: { days: 7, ambientDeltaC: -10, roomDeltaC: -4, rampMs: 12 * MS_PER_HOUR },
  /** 흐린 주: 운량 하한 0.85 (청천 대비 GHI 약 39%) */
  cloudyWeek: { days: 7, cloudMin: 0.85 },
  /** 출력제어: 7일 간격, KST 11~15시 인버터 출력 제한 0% */
  curtailment: { intervalDays: 7, startHour: 11, hours: 4, limitPct: 0, maxCount: 52 },
  /** 전해조 부분부하 주간: 정격의 40%까지만 운전 */
  elzPartLoadWeek: { days: 7, maxLoadFraction: 0.4 },
  /** 연료전지 잦은 기동·정지 주간: EMS_SETTINGS.integrated.fcCycling 일정으로 운전 */
  fcFrequentStartStop: { days: 7 },
  socUpperLimit: { min: 0.5, max: 1 },
});

export interface ColdWeekControl {
  readonly kind: 'control.cold_week';
  readonly site: string;
  readonly startDay: number;
}
export interface CloudyWeekControl {
  readonly kind: 'control.cloudy_week';
  readonly site: string;
  readonly startDay: number;
}
export interface CurtailmentControl {
  readonly kind: 'control.curtailment';
  readonly site: string;
  /** 첫 출력제어일. 이후 intervalDays 간격 */
  readonly startDay: number;
  readonly count: number;
}
export interface ElzPartLoadWeekControl {
  readonly kind: 'control.elz_part_load_week';
  readonly site: string;
  readonly startDay: number;
}
export interface FcFrequentStartStopControl {
  readonly kind: 'control.fc_frequent_start_stop';
  readonly site: string;
  readonly startDay: number;
}
/** EMS 충전 SOC 상한 설정 변경 (asset = ess.plant 설비 코드). 운영 이벤트 asset_event(setpoint_change)가 함께 나온다. */
export interface SocUpperLimitChangeControl {
  readonly kind: 'control.soc_upper_limit_change';
  readonly site: string;
  readonly asset: string;
  readonly day: number;
  /** 새 상한 (0.5~1, 0.8 = 80%) */
  readonly newLimit: number;
}

export type ControlScenario =
  | ColdWeekControl
  | CloudyWeekControl
  | CurtailmentControl
  | ElzPartLoadWeekControl
  | FcFrequentStartStopControl
  | SocUpperLimitChangeControl;

export type ControlKind = ControlScenario['kind'];

export interface ColdWindow extends TimeWindow {
  readonly ambientDeltaC: number;
  readonly roomDeltaC: number;
}
export interface CloudyWindow extends TimeWindow {
  readonly cloudMin: number;
}
export interface CurtailmentWindow extends TimeWindow {
  readonly limitPct: number;
}
export interface ElzLoadCapWindow extends TimeWindow {
  readonly maxLoadFraction: number;
}
export interface SocLimitChange {
  readonly atMs: number;
  readonly assetCode: string;
  readonly newLimit: number;
}

/** 사이트 계획 중 대조군 조건 부분 */
export interface ControlPlan {
  readonly coldWeeks: readonly ColdWindow[];
  readonly cloudyWeeks: readonly CloudyWindow[];
  readonly curtailments: readonly CurtailmentWindow[];
  readonly elzPartLoads: readonly ElzLoadCapWindow[];
  readonly fcStartStops: readonly TimeWindow[];
  /** 시각 오름차순 */
  readonly socLimitChanges: readonly SocLimitChange[];
}

export const EMPTY_CONTROL_PLAN: ControlPlan = Object.freeze({
  coldWeeks: [],
  cloudyWeeks: [],
  curtailments: [],
  elzPartLoads: [],
  fcStartStops: [],
  socLimitChanges: [],
});

export const CONTROL_KINDS: readonly ControlKind[] = [
  'control.cold_week',
  'control.cloudy_week',
  'control.curtailment',
  'control.elz_part_load_week',
  'control.fc_frequent_start_stop',
  'control.soc_upper_limit_change',
];

export const isControl = (scenario: { readonly kind: string }): scenario is ControlScenario =>
  (CONTROL_KINDS as readonly string[]).includes(scenario.kind);

export function dayMs(originMs: number, day: number, label: string): number {
  if (!Number.isInteger(day) || day < 0) throw new Error(`${label} 일수는 0 이상의 정수여야 합니다: ${day}`);
  return originMs + day * MS_PER_DAY;
}

export const weekOf = (originMs: number, startDay: number, days: number, label: string): TimeWindow => {
  const startMs = dayMs(originMs, startDay, label);
  return { startMs, endMs: startMs + days * MS_PER_DAY };
};

export function requireClass(site: SiteDef, classKey: string, label: string): void {
  if (!site.assets.some((a) => a.classKey === classKey)) throw new Error(`${label}: ${site.code}에 ${classKey} 설비가 없습니다`);
}

function curtailmentWindows(control: CurtailmentControl, originMs: number, label: string): CurtailmentWindow[] {
  const s = CONTROL_SETTINGS.curtailment;
  if (!Number.isInteger(control.count) || control.count < 1 || control.count > s.maxCount) throw new Error(`${label} count는 1~${s.maxCount}: ${control.count}`);
  return Array.from({ length: control.count }, (_, i) => {
    const startMs = dayMs(originMs, control.startDay + i * s.intervalDays, label) + s.startHour * MS_PER_HOUR;
    return { startMs, endMs: startMs + s.hours * MS_PER_HOUR, limitPct: s.limitPct };
  });
}

function socLimitChange(site: SiteDef, control: SocUpperLimitChangeControl, originMs: number, label: string): SocLimitChange {
  const { min, max } = CONTROL_SETTINGS.socUpperLimit;
  if (!Number.isFinite(control.newLimit) || control.newLimit < min || control.newLimit > max) throw new Error(`${label} newLimit은 ${min}~${max}: ${control.newLimit}`);
  const asset = site.assets.find((a) => a.code === control.asset && a.classKey === 'ess.plant');
  if (!asset) throw new Error(`${label}: ${site.code}에 ess.plant 설비 ${control.asset}이(가) 없습니다`);
  return { atMs: dayMs(originMs, control.day, label), assetCode: asset.code, newLimit: control.newLimit };
}

/** 대조군 시나리오를 검증해 계획에 더한 새 계획을 돌려준다. */
export function applyControl<P extends ControlPlan>(plan: P, site: SiteDef, control: ControlScenario, originMs: number): P {
  const label = `${control.kind}(${site.code})`;
  const s = CONTROL_SETTINGS;
  switch (control.kind) {
    case 'control.cold_week': {
      const window = weekOf(originMs, control.startDay, s.coldWeek.days, label);
      return { ...plan, coldWeeks: [...plan.coldWeeks, { ...window, ambientDeltaC: s.coldWeek.ambientDeltaC, roomDeltaC: s.coldWeek.roomDeltaC }] };
    }
    case 'control.cloudy_week': {
      const window = weekOf(originMs, control.startDay, s.cloudyWeek.days, label);
      return { ...plan, cloudyWeeks: [...plan.cloudyWeeks, { ...window, cloudMin: s.cloudyWeek.cloudMin }] };
    }
    case 'control.curtailment':
      requireClass(site, 'pv.inverter', label);
      return { ...plan, curtailments: [...plan.curtailments, ...curtailmentWindows(control, originMs, label)] };
    case 'control.elz_part_load_week': {
      requireClass(site, 'h2.elz', label);
      const window = weekOf(originMs, control.startDay, s.elzPartLoadWeek.days, label);
      return { ...plan, elzPartLoads: [...plan.elzPartLoads, { ...window, maxLoadFraction: s.elzPartLoadWeek.maxLoadFraction }] };
    }
    case 'control.fc_frequent_start_stop':
      requireClass(site, 'fc.plant', label);
      return { ...plan, fcStartStops: [...plan.fcStartStops, weekOf(originMs, control.startDay, s.fcFrequentStartStop.days, label)] };
    case 'control.soc_upper_limit_change': {
      const changes = [...plan.socLimitChanges, socLimitChange(site, control, originMs, label)].sort((a, b) => a.atMs - b.atMs);
      return { ...plan, socLimitChanges: changes };
    }
  }
}

/** 그 시각의 EMS 충전 SOC 상한 */
export function socMaxAt(plan: Pick<ControlPlan, 'socLimitChanges'>, tMs: number): number {
  return plan.socLimitChanges.findLast((c) => c.atMs <= tMs)?.newLimit ?? EMS_SETTINGS.socMax;
}

/** 스텝마다 플랜트·EMS에 넘기는 대조군 조건 */
export interface StepControls {
  /** 인버터 출력 제한 [%] (100 = 제한 없음) */
  readonly pvLimitPct: number;
  readonly socMax: number;
  /** 전해조 최대 부하 비율 (1 = 정격) */
  readonly elzLoadCap: number;
  readonly fcCycling: boolean;
  /** 배터리실 온도 편차 [°C] */
  readonly roomDeltaC: number;
}

export function controlsAt(plan: ControlPlan, tMs: number): StepControls {
  const active = <W extends TimeWindow>(windows: readonly W[]) => windows.filter((w) => isInWindow(w, tMs));
  return {
    pvLimitPct: Math.min(100, ...active(plan.curtailments).map((w) => w.limitPct)),
    socMax: socMaxAt(plan, tMs),
    elzLoadCap: Math.min(1, ...active(plan.elzPartLoads).map((w) => w.maxLoadFraction)),
    fcCycling: plan.fcStartStops.some((w) => isInWindow(w, tMs)),
    roomDeltaC: plan.coldWeeks.reduce((sum, w) => sum + w.roomDeltaC * edgeRampFraction(w, tMs, CONTROL_SETTINGS.coldWeek.rampMs), 0),
  };
}

/** 합성 기상에 넣을 편차 구간 */
export function weatherWindowsOf(plan: ControlPlan): readonly WeatherWindow[] {
  return [
    ...plan.coldWeeks.map((w): WeatherWindow => ({ startMs: w.startMs, endMs: w.endMs, ambientDeltaC: w.ambientDeltaC, cloudMin: 0, rampMs: CONTROL_SETTINGS.coldWeek.rampMs })),
    ...plan.cloudyWeeks.map((w): WeatherWindow => ({ startMs: w.startMs, endMs: w.endMs, ambientDeltaC: 0, cloudMin: w.cloudMin, rampMs: 0 })),
  ];
}
