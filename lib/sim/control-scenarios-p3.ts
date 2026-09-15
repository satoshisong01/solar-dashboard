// P3 음성 대조군 시나리오: 수소 저장·압축기·태양광 오염·인버터 온도·연료전지 블로워 탐지기가 속기 쉬운 운전·기상 조건.
// startDay는 실행 기준일(실행 시작 시각이 속한 KST 날짜 0시)부터 센 일수다.
// 전해조 부분부하 함정은 P2 control.elz_part_load_week를 그대로 쓴다 (el.sec_rise도 속기 쉬운 탐지기로 올린다).
import type { SiteDef } from '@/db/seed/types';
import { dayMs, requireClass, weekOf } from './control-scenarios';
import { edgeRampFraction, isInWindow, kstHourOfDay, MS_PER_HOUR, MS_PER_MINUTE, type TimeWindow } from './math';
import type { WeatherWindow } from './weather';

export const P3_CONTROL_SETTINGS = Object.freeze({
  /** 고온 주: 외기 +8 °C (양끝 12시간 램프) — 인버터 방열판·블로워 전력이 함께 오른다 */
  hotWeek: { days: 7, ambientDeltaC: 8, rampMs: 12 * MS_PER_HOUR },
  /** 비 오는 주: 운량 하한 0.8, 매일 KST 04~12시 강한 비 (끈적한 오염층까지 씻긴다) */
  rainyWeek: { days: 7, cloudMin: 0.8, rainStartHour: 4, rainHours: 8 },
  /** 일교차 확대: 용기 주변 온도에 진폭 12 °C 일변화(14시 최고)를 더한다 (양끝 12시간 램프). 벽 열용량 때문에 가스 온도 진폭은 약 ±5 °C, 최고 시각은 약 4시간 늦다 */
  dayNightSwing: { days: 7, amplitudeC: 12, peakHour: 14, rampMs: 12 * MS_PER_HOUR },
  /** 보유 중 짧은 충전: 매일 KST 02시부터 60분 전해조 최소부하 운전(심야 계통 전력)으로 저장뱅크를 조금 채운다 */
  tankRefillTopoff: { days: 7, startHour: 2, minutes: 60 },
  /** 높은 압력비 운전: 압축기 흡입 압력을 15 bar로 낮춘다 (전해조 출구 30 bar는 그대로) */
  compressorHighRatioWeek: { days: 7, suctionBar: 15 },
  /** 건강한 물질수지 확인 구간: 고장 없는 사이트에서 일 잔차 < 1% */
  healthyMassBalance: { minDays: 7, maxDays: 366, maxResidualPct: 1 },
});

export interface HotWeekControl {
  readonly kind: 'control.hot_week';
  readonly site: string;
  readonly startDay: number;
}
export interface RainyWeekControl {
  readonly kind: 'control.rainy_week';
  readonly site: string;
  readonly startDay: number;
}
export interface DayNightSwingControl {
  readonly kind: 'control.day_night_swing';
  readonly site: string;
  readonly startDay: number;
}
export interface TankRefillTopoffControl {
  readonly kind: 'control.tank_refill_topoff';
  readonly site: string;
  readonly startDay: number;
}
export interface CompressorHighRatioWeekControl {
  readonly kind: 'control.compressor_high_ratio_week';
  readonly site: string;
  readonly startDay: number;
}
/** 물리 조건을 바꾸지 않는 정답 표시: 이 구간 수소 원장 잔차가 1% 미만이어야 한다 (고장이 있는 사이트에는 넣을 수 없다) */
export interface HealthyMassBalanceControl {
  readonly kind: 'control.healthy_mass_balance';
  readonly site: string;
  readonly startDay: number;
  readonly days: number;
}

export type P3ControlScenario =
  | HotWeekControl
  | RainyWeekControl
  | DayNightSwingControl
  | TankRefillTopoffControl
  | CompressorHighRatioWeekControl
  | HealthyMassBalanceControl;

export type P3ControlKind = P3ControlScenario['kind'];

export const P3_CONTROL_KINDS: readonly P3ControlKind[] = [
  'control.hot_week',
  'control.rainy_week',
  'control.day_night_swing',
  'control.tank_refill_topoff',
  'control.compressor_high_ratio_week',
  'control.healthy_mass_balance',
];

export const isP3Control = (scenario: { readonly kind: string }): scenario is P3ControlScenario =>
  (P3_CONTROL_KINDS as readonly string[]).includes(scenario.kind);

export interface HotWindow extends TimeWindow {
  readonly ambientDeltaC: number;
}
export interface SwingWindow extends TimeWindow {
  readonly amplitudeC: number;
}
export interface SuctionWindow extends TimeWindow {
  readonly suctionBar: number;
}

/** 사이트 계획 중 P3 대조군 조건 부분 */
export interface P3ControlPlan {
  readonly hotWeeks: readonly HotWindow[];
  /** 비 오는 주 전체 구간 (정답 기록용. 실제 강우는 rainWindows) */
  readonly rainyWeeks: readonly TimeWindow[];
  readonly tankSwings: readonly SwingWindow[];
  /** 보유 중 짧은 충전 주 전체 구간 (정답 기록용. 실제 운전은 topoffs) */
  readonly topoffWeeks: readonly TimeWindow[];
  readonly topoffs: readonly TimeWindow[];
  readonly highRatioWeeks: readonly SuctionWindow[];
  readonly healthyBalances: readonly TimeWindow[];
}

export interface AssetMoment {
  readonly atMs: number;
  readonly assetCode: string;
}

/** 고장·대조군이 만드는 이벤트: 강한 비(대조군 비 오는 주 + 오염 고장 강우일), 모듈 세척, 공기 필터 교체 */
export interface P3EventPlan {
  readonly rainWindows: readonly TimeWindow[];
  readonly pvCleanings: readonly AssetMoment[];
  readonly filterReplacements: readonly AssetMoment[];
}

export const EMPTY_P3_CONTROL_PLAN: P3ControlPlan = Object.freeze({
  hotWeeks: [],
  rainyWeeks: [],
  tankSwings: [],
  topoffWeeks: [],
  topoffs: [],
  highRatioWeeks: [],
  healthyBalances: [],
});

export const EMPTY_P3_EVENT_PLAN: P3EventPlan = Object.freeze({ rainWindows: [], pvCleanings: [], filterReplacements: [] });

/** day부터 days일 동안 매일 KST startHour시부터 durationMs 구간 */
function dailyWindows(originMs: number, startDay: number, days: number, startHour: number, durationMs: number, label: string): TimeWindow[] {
  return Array.from({ length: days }, (_, i) => {
    const startMs = dayMs(originMs, startDay + i, label) + startHour * MS_PER_HOUR;
    return { startMs, endMs: startMs + durationMs };
  });
}

function healthyWindow(control: HealthyMassBalanceControl, originMs: number, label: string): TimeWindow {
  const { minDays, maxDays } = P3_CONTROL_SETTINGS.healthyMassBalance;
  if (!Number.isInteger(control.days) || control.days < minDays || control.days > maxDays) throw new Error(`${label} days는 ${minDays}~${maxDays} 정수: ${control.days}`);
  return weekOf(originMs, control.startDay, control.days, label);
}

type PlanWithP3 = P3ControlPlan & P3EventPlan;

/** P3 대조군 시나리오를 검증해 계획에 더한 새 계획을 돌려준다. */
export function applyP3Control<P extends PlanWithP3>(plan: P, site: SiteDef, control: P3ControlScenario, originMs: number): P {
  const label = `${control.kind}(${site.code})`;
  const s = P3_CONTROL_SETTINGS;
  switch (control.kind) {
    case 'control.hot_week':
      return { ...plan, hotWeeks: [...plan.hotWeeks, { ...weekOf(originMs, control.startDay, s.hotWeek.days, label), ambientDeltaC: s.hotWeek.ambientDeltaC }] };
    case 'control.rainy_week': {
      const rains = dailyWindows(originMs, control.startDay, s.rainyWeek.days, s.rainyWeek.rainStartHour, s.rainyWeek.rainHours * MS_PER_HOUR, label);
      return { ...plan, rainyWeeks: [...plan.rainyWeeks, weekOf(originMs, control.startDay, s.rainyWeek.days, label)], rainWindows: [...plan.rainWindows, ...rains] };
    }
    case 'control.day_night_swing':
      requireClass(site, 'h2.storage.tank', label);
      return { ...plan, tankSwings: [...plan.tankSwings, { ...weekOf(originMs, control.startDay, s.dayNightSwing.days, label), amplitudeC: s.dayNightSwing.amplitudeC }] };
    case 'control.tank_refill_topoff': {
      requireClass(site, 'h2.elz', label);
      const nights = dailyWindows(originMs, control.startDay, s.tankRefillTopoff.days, s.tankRefillTopoff.startHour, s.tankRefillTopoff.minutes * MS_PER_MINUTE, label);
      return { ...plan, topoffWeeks: [...plan.topoffWeeks, weekOf(originMs, control.startDay, s.tankRefillTopoff.days, label)], topoffs: [...plan.topoffs, ...nights] };
    }
    case 'control.compressor_high_ratio_week':
      requireClass(site, 'h2.compressor', label);
      return { ...plan, highRatioWeeks: [...plan.highRatioWeeks, { ...weekOf(originMs, control.startDay, s.compressorHighRatioWeek.days, label), suctionBar: s.compressorHighRatioWeek.suctionBar }] };
    case 'control.healthy_mass_balance':
      requireClass(site, 'h2.storage.tank', label);
      return { ...plan, healthyBalances: [...plan.healthyBalances, healthyWindow(control, originMs, label)] };
  }
}

/** 스텝마다 플랜트·EMS에 넘기는 P3 조건 */
export interface P3StepControls {
  /** 용기 주변 온도 일교차 확대 편차 [°C] */
  readonly tankSwingC: number;
  /** 압축기 흡입 압력 강제값 [bar] (null = 전해조 출구 압력) */
  readonly suctionBar: number | null;
  /** 보유 중 짧은 충전 운전 */
  readonly elzTopoff: boolean;
  /** 이 스텝에 모듈 세척 (세척 시각부터 5분 구간) */
  readonly pvCleaning: boolean;
}

const CLEANING_WINDOW_MS = 5 * MS_PER_MINUTE;

function swingC(windows: readonly SwingWindow[], tMs: number): number {
  const { peakHour, rampMs } = P3_CONTROL_SETTINGS.dayNightSwing;
  const diurnal = Math.cos((2 * Math.PI * (kstHourOfDay(tMs) - peakHour)) / 24);
  return windows.reduce((sum, w) => sum + w.amplitudeC * diurnal * edgeRampFraction(w, tMs, rampMs), 0);
}

export function p3ControlsAt(plan: PlanWithP3, tMs: number): P3StepControls {
  return {
    tankSwingC: swingC(plan.tankSwings, tMs),
    suctionBar: plan.highRatioWeeks.find((w) => isInWindow(w, tMs))?.suctionBar ?? null,
    elzTopoff: plan.topoffs.some((w) => isInWindow(w, tMs)),
    pvCleaning: plan.pvCleanings.some((c) => tMs >= c.atMs && tMs < c.atMs + CLEANING_WINDOW_MS),
  };
}

/** 합성 기상에 넣을 P3 편차 구간: 고온 주(기온), 비 오는 주 운량 하한, 강한 비 */
export function p3WeatherWindows(plan: PlanWithP3): readonly WeatherWindow[] {
  const s = P3_CONTROL_SETTINGS;
  return [
    ...plan.hotWeeks.map((w): WeatherWindow => ({ startMs: w.startMs, endMs: w.endMs, ambientDeltaC: w.ambientDeltaC, cloudMin: 0, rampMs: s.hotWeek.rampMs })),
    ...plan.rainyWeeks.map((w): WeatherWindow => ({ startMs: w.startMs, endMs: w.endMs, ambientDeltaC: 0, cloudMin: s.rainyWeek.cloudMin, rampMs: 0 })),
    ...plan.rainWindows.map((w): WeatherWindow => ({ startMs: w.startMs, endMs: w.endMs, ambientDeltaC: 0, cloudMin: 0, rampMs: 0, rain: true })),
  ];
}
