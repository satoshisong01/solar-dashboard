// load 계층이 원시·롤업을 어느 구간만 읽을지 정하는 순수 규칙. DB 실행기(lib/analysis)와 시뮬레이터 평가(lib/sim/eval)가 같은 규칙을 쓴다.
//   tank.hold 후보: 1시간 롤업에서 유입·유출 신호가 모두 멈춘 시간의 연속 구간 → 앞뒤 2시간을 붙여 합친 창만 원시를 읽어 추출한다.
//     후보 앞뒤 시간에는 멈추지 않은 샘플(또는 데이터 없음)이 있으므로, 2시간 여유면 실제 정지 구간의 시작·끝이 창 경계에 걸리지 않는다.
//   inv.thermal_derating 표본: 최근 recentDays일 + 기준 비교용 THERMAL_REFERENCE_DAYS일만 원시에서 5분 버킷으로 만든다.
//   el.sec_rise 정류기 효율: 1시간 롤업 최솟값이 운전 기준 이상인(한 시간 내내 운전한) 시간의 KST 일 중앙값.
import type { TimedNumber } from '../detectors/common';
import { DEFAULT_TANK_HOLD_PARAMS } from '../episodes/tank-hold';
import { median } from '../stats/robust';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '../types';

/** 1시간 롤업 한 행에서 판정에 필요한 값 */
export interface HourStat {
  readonly metricKey: string;
  readonly hourStart: number;
  readonly nGood: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
}

interface FlowSignalRule {
  readonly metricKey: string;
  readonly side: 'inflow' | 'outflow';
  /** 한 시간 최솟값·최댓값이 모두 이 규칙을 만족하면 그 시간 동안 흐름이 없었다 */
  readonly idle: (min: number, max: number) => boolean;
}

const p = DEFAULT_TANK_HOLD_PARAMS;

/** tank.hold 추출기(episodes/tank-hold.ts)의 정지 판정과 같은 신호·기준 */
export const TANK_FLOW_SIGNALS: readonly FlowSignalRule[] = [
  { metricKey: 'valve.open#inlet', side: 'inflow', idle: (_, max) => max < 0.5 },
  { metricKey: 'compressor.power', side: 'inflow', idle: (_, max) => max <= p.compressorOffKw },
  { metricKey: 'h2.flow.mass', side: 'inflow', idle: (min, max) => Math.max(Math.abs(min), Math.abs(max)) <= p.flowEpsKgH },
  { metricKey: 'valve.open#outlet', side: 'outflow', idle: (_, max) => max < 0.5 },
  { metricKey: 'fc.h2.consumption', side: 'outflow', idle: (min, max) => Math.max(Math.abs(min), Math.abs(max)) <= p.flowEpsKgH },
];

export const TANK_WINDOW_PADDING_MS = 2 * MS_PER_HOUR;

/**
 * 원시를 읽을 tank.hold 추출 창. present = 포인트가 있는 신호 메트릭 키.
 * 유입·유출 쪽 신호가 하나씩은 있어야 한다 (없으면 추출기가 정지를 확정하지 못하므로 빈 배열).
 * 신호가 있는데 그 시간 롤업이 없거나 good 샘플이 없으면 정지로 보지 않는다 (추출기와 같이 보수적).
 */
export function tankHoldWindows(hours: readonly HourStat[], present: ReadonlySet<string>, window: TimeWindow): TimeWindow[] {
  const signals = TANK_FLOW_SIGNALS.filter((s) => present.has(s.metricKey));
  if (!signals.some((s) => s.side === 'inflow') || !signals.some((s) => s.side === 'outflow')) return [];
  const byKey = new Map(hours.map((h) => [`${h.metricKey}|${h.hourStart}`, h]));
  const isStaticHour = (hourStart: number) =>
    signals.every((s) => {
      const h = byKey.get(`${s.metricKey}|${hourStart}`);
      return h !== undefined && h.nGood > 0 && h.min !== null && h.max !== null && s.idle(h.min, h.max);
    });
  const first = Math.floor(window.start / MS_PER_HOUR) * MS_PER_HOUR;
  const staticHours = Array.from({ length: Math.max(0, Math.ceil((window.end - first) / MS_PER_HOUR)) }, (_, i) => first + i * MS_PER_HOUR).filter(isStaticHour);
  const padded = staticHours.map((h) => ({ start: Math.max(window.start, h - TANK_WINDOW_PADDING_MS), end: Math.min(window.end, h + MS_PER_HOUR + TANK_WINDOW_PADDING_MS) }));
  return padded.reduce<TimeWindow[]>((merged, w) => {
    const last = merged.at(-1);
    return last && w.start <= last.end ? [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, w.end) }] : [...merged, w];
  }, []);
}

/** 열 저감 기준 비교(외기 bin별 기준일)에 쓰는 최근 기간 앞 일수 */
export const THERMAL_REFERENCE_DAYS = 60;

export const thermalSampleWindow = (now: number, recentDays: number): TimeWindow => ({ start: kstDayStart(now) - (recentDays + THERMAL_REFERENCE_DAYS) * MS_PER_DAY, end: now });

/** 정류기가 한 시간 내내 운전했다고 보는 효율 최솟값 [%] (정지 중에는 0으로 보고된다) */
export const RECTIFIER_RUNNING_MIN_PCT = 50;

/** 정류기 효율 1시간 롤업 → KST 일 중앙값 (한 시간 내내 운전한 시간의 평균만, 시각은 그날 정오) */
export function rectifierEfficiencyDays(hours: readonly Pick<HourStat, 'hourStart' | 'nGood' | 'min' | 'avg'>[]): TimedNumber[] {
  const byDay = new Map<number, number[]>();
  for (const h of hours) {
    if (h.nGood <= 0 || h.min === null || h.avg === null || h.min < RECTIFIER_RUNNING_MIN_PCT) continue;
    const day = kstDayStart(h.hourStart);
    byDay.set(day, [...(byDay.get(day) ?? []), h.avg]);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, values]) => ({ ts: day + MS_PER_DAY / 2, value: median(values) }));
}
