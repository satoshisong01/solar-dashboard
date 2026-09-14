// ESS 전류 → 충전·방전·휴지 구간 분할 (설계 §3.1):
//   |I| > 0.02C가 2분 이상 → 충전/방전 시작, |I| ≤ 0.02C가 5분 이상 → 종료, 짧은 휴지·반대 방향 블립은 병합.
//   데이터 공백이 maxGap(2분)을 넘으면 거기서 끊는다 (2분 이하 공백은 이어 붙인다).
import type { TimedValue } from './series';

export type ActivityState = 'charge' | 'discharge' | 'rest';

export interface ActivityRun {
  readonly state: ActivityState | 'gap';
  readonly start: number;
  readonly end: number;
}

export type SegmentEndReason = 'rest' | 'reversal' | 'gap' | 'data_end';

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly endReason: SegmentEndReason;
}

export interface SegmentRules {
  readonly thresholdA: number;
  readonly periodMs: number;
  readonly maxGapMs: number;
  readonly minActiveMs: number;
  readonly minRestMs: number;
}

const stateOf = (current: number, thresholdA: number): ActivityState =>
  current > thresholdA ? 'charge' : current < -thresholdA ? 'discharge' : 'rest';

/** 같은 상태가 이어지는 구간. 상태가 바뀌면 다음 샘플 시각에서 끊고, maxGap 넘는 공백은 gap 구간으로 넣는다. */
export function activityRuns(points: readonly TimedValue[], rules: Pick<SegmentRules, 'thresholdA' | 'periodMs' | 'maxGapMs'>): ActivityRun[] {
  const runs: ActivityRun[] = [];
  let current: { state: ActivityState; start: number } | null = null;
  let previousTs = Number.NaN;
  for (const point of points) {
    const state = stateOf(point.value, rules.thresholdA);
    if (current && point.ts - previousTs > rules.maxGapMs) {
      const end = previousTs + rules.periodMs;
      runs.push({ state: current.state, start: current.start, end }, { state: 'gap', start: end, end: point.ts });
      current = null;
    }
    if (current && current.state !== state) {
      runs.push({ state: current.state, start: current.start, end: point.ts });
      current = null;
    }
    current ??= { state, start: point.ts };
    previousTs = point.ts;
  }
  if (current) runs.push({ state: current.state, start: current.start, end: previousTs + rules.periodMs });
  return runs;
}

const duration = (run: ActivityRun): number => run.end - run.start;

interface OpenSpan {
  readonly start: number;
  readonly end: number;
  readonly restMs: number;
}

interface SegmentState {
  readonly segments: readonly Segment[];
  readonly open: OpenSpan | null;
}

const EMPTY: SegmentState = { segments: [], open: null };

/** 열린 구간을 닫는다. 휴지 합계가 minRestMs 미만이면 버린다 (활성 구간은 minRestMs = 0) */
function closeSpan(state: SegmentState, endReason: SegmentEndReason, minRestMs = 0): SegmentState {
  if (!state.open) return state;
  if (state.open.restMs < minRestMs) return { segments: state.segments, open: null };
  return { segments: [...state.segments, { start: state.open.start, end: state.open.end, endReason }], open: null };
}

/** 한 방향(charge/discharge) 세그먼트: 2분 이상 활성으로 시작, 5분 휴지·2분 이상 반대 방향·공백·데이터 끝에서 종료 */
export function activeSegments(runs: readonly ActivityRun[], direction: 'charge' | 'discharge', rules: SegmentRules): Segment[] {
  const opposite = direction === 'charge' ? 'discharge' : 'charge';
  const final = runs.reduce<SegmentState>((state, run) => {
    if (run.state === direction) {
      if (state.open) return { ...state, open: { ...state.open, end: run.end } };
      return duration(run) >= rules.minActiveMs ? { ...state, open: { start: run.start, end: run.end, restMs: 0 } } : state;
    }
    if (run.state === 'gap') return closeSpan(state, 'gap');
    if (run.state === 'rest' && duration(run) >= rules.minRestMs) return closeSpan(state, 'rest');
    if (run.state === opposite && duration(run) >= rules.minActiveMs) return closeSpan(state, 'reversal');
    return state;
  }, EMPTY);
  return [...closeSpan(final, 'data_end').segments];
}

/** 휴지 세그먼트: 활성 세그먼트 밖에서 휴지(와 짧은 블립)가 이어진 구간 중 휴지 합계가 minRest 이상인 것 */
export function restSegments(runs: readonly ActivityRun[], active: readonly Segment[], rules: SegmentRules): Segment[] {
  const insideActive = (run: ActivityRun) => active.some((s) => run.start >= s.start && run.end <= s.end);
  const final = runs.reduce<SegmentState>((state, run) => {
    if (run.state === 'gap') return closeSpan(state, 'gap', rules.minRestMs);
    if (insideActive(run)) return closeSpan(state, 'reversal', rules.minRestMs);
    const restMs = run.state === 'rest' ? duration(run) : 0;
    const open = state.open ? { ...state.open, end: run.end, restMs: state.open.restMs + restMs } : { start: run.start, end: run.end, restMs };
    return { ...state, open };
  }, EMPTY);
  return [...closeSpan(final, 'data_end', rules.minRestMs).segments];
}
