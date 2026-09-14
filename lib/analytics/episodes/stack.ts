// 전해조·연료전지 스택 공통: 정상운전 구간(steady run)과 기동(start) 찾기.
// 정상운전 = 운전 중(전류 ≥ 정격 × runningFraction) 전류가 구간 평균 ±5% 안에서 10분 이상 유지.
// 기동 = 비운전 샘플이 관측된 뒤 startOffMinS 넘게 꺼져 있다가 처음 운전한 샘플.
import { MS_PER_SECOND, type TimeWindow } from '../types';
import type { TimedValue } from './series';

export interface StackRunRules {
  readonly steadyTolerance: number;
  readonly steadyMinS: number;
  readonly maxGapS: number;
  readonly runningFraction: number;
  readonly startOffMinS: number;
}

export const DEFAULT_STACK_RUN_RULES: StackRunRules = Object.freeze({
  steadyTolerance: 0.05,
  steadyMinS: 600,
  maxGapS: 120,
  runningFraction: 0.1,
  startOffMinS: 600,
});

export interface SteadyWindow extends TimeWindow {
  readonly meanCurrentA: number;
  /** 창 시작 직후 또는 창 끝까지 이어진 구간 */
  readonly open: boolean;
}

export interface StartEvent {
  readonly ts: number;
  /** 직전 비운전 시간 [ms]. 창 시작 전부터 꺼져 있었으면 null (관측 길이만 startOffMinS 이상) */
  readonly offMs: number | null;
}

interface Building {
  readonly start: number;
  readonly lastTs: number;
  readonly sum: number;
  readonly count: number;
}

interface WindowRules {
  readonly window: TimeWindow;
  readonly periodMs: number;
  readonly minMs: number;
  readonly edgeMs: number;
}

function finish(building: Building | null, dataEnded: boolean, rules: WindowRules): SteadyWindow[] {
  if (!building) return [];
  const end = building.lastTs + rules.periodMs;
  if (end - building.start < rules.minMs) return [];
  const open = building.start - rules.window.start <= rules.edgeMs || (dataEnded && rules.window.end - end <= rules.edgeMs);
  return [{ start: building.start, end, meanCurrentA: building.sum / building.count, open }];
}

/** 전류 샘플(ts 오름차순, 창 안) → 정상운전 구간 */
export function steadyWindows(current: readonly TimedValue[], window: TimeWindow, ratedCurrentA: number, periodMs: number, rules: StackRunRules): SteadyWindow[] {
  const runningA = rules.runningFraction * ratedCurrentA;
  const maxGapMs = rules.maxGapS * MS_PER_SECOND;
  const windowRules: WindowRules = { window, periodMs, minMs: rules.steadyMinS * MS_PER_SECOND, edgeMs: periodMs + maxGapMs };
  const windows: SteadyWindow[] = [];
  let building: Building | null = null;
  for (const point of current) {
    if (point.value < runningA) {
      windows.push(...finish(building, false, windowRules));
      building = null;
      continue;
    }
    if (building) {
      const mean = building.sum / building.count;
      if (point.ts - building.lastTs > maxGapMs || Math.abs(point.value - mean) > rules.steadyTolerance * mean) {
        windows.push(...finish(building, false, windowRules));
        building = null;
      }
    }
    const previous: Building | null = building;
    const next: Building = previous
      ? { start: previous.start, lastTs: point.ts, sum: previous.sum + point.value, count: previous.count + 1 }
      : { start: point.ts, lastTs: point.ts, sum: point.value, count: 1 };
    building = next;
  }
  windows.push(...finish(building, true, windowRules));
  return windows;
}

/** 추출 창 시작 전 운전 상태 (load 계층이 원시에서 따로 조회한다) */
export interface StackPriorState {
  /** 창 시작 전 마지막 운전 샘플 시각. 없으면 null */
  readonly lastRunningTs: number | null;
  /** 창 시작 직전 마지막 good 샘플이 비운전 */
  readonly offBeforeWindow: boolean;
}

/**
 * 전류 샘플 → 기동 이벤트.
 * prior를 주면 창 첫 기동의 꺼짐 시간을 창 앞 마지막 운전 시각부터 잰다 (끝 구간만 다시 추출해도 전체 추출과 같은 off_duration_s·cold).
 * 없으면 창 앞은 모르는 것으로 보고 창 첫 기동의 꺼짐 시간은 null.
 */
export function startEvents(current: readonly TimedValue[], ratedCurrentA: number, rules: StackRunRules, prior: StackPriorState | null = null): StartEvent[] {
  const runningA = rules.runningFraction * ratedCurrentA;
  const minOffMs = rules.startOffMinS * MS_PER_SECOND;
  const events: StartEvent[] = [];
  const firstTs = current[0]?.ts ?? 0;
  const priorRunning = prior?.lastRunningTs ?? null;
  let lastRunningTs: number | null = priorRunning !== null && priorRunning < firstTs ? priorRunning : null;
  let sawOff = prior?.offBeforeWindow ?? false;
  for (const point of current) {
    if (point.value < runningA) {
      sawOff = true;
      continue;
    }
    if (sawOff && point.ts - (lastRunningTs ?? firstTs) >= minOffMs) {
      events.push({ ts: point.ts, offMs: lastRunningTs === null ? null : point.ts - lastRunningTs });
    }
    lastRunningTs = point.ts;
    sawOff = false;
  }
  return events;
}
