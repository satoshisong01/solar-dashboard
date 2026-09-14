// 전해조·연료전지 스택 에피소드: el.steady_run@1 · el.start@1 · fc.steady_run@1 · fc.start@1.
// 입력 메트릭 (스택 + 상위 설비를 한 맵으로):
//   공통 stack.current(A) · stack.voltage(V) · stack.temp(°C) · run.hours(h) · start.count
//   전해조 h2.flow.mass(kg/h) · ac.power(kW)   연료전지 fc.h2.consumption(kg/h) · fc.ac.power(kW) · blower.power(kW)
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../types';
import { binFloor, goodPoints, meanValue, metricDq, nominalPeriodMs, pointsIn, rangeIntegral, round, roundOrNull, valueAtOrBefore, valueNear, worstDq, type TimedValue } from './series';
import { DEFAULT_STACK_RUN_RULES, startEvents, steadyWindows, type StackRunRules, type SteadyWindow } from './stack';
import { extractorId, validity, type Episode, type EpisodeDq, type ExtractInput } from './types';

export interface StackNameplate {
  readonly cell_count: number;
  readonly active_area_cm2: number;
  readonly rated_current_a: number;
}

export interface StackExtractorParams extends StackRunRules {
  readonly jBinWidth: number;
  readonly tempBinWidthC: number;
  readonly fallbackPeriodS: number;
  readonly minCompleteness: number;
  /** 이만큼 넘게 꺼져 있다가 기동하면 냉간 기동 */
  readonly coldOffS: number;
  /** 기동 후 이 시간 안의 첫 정상운전까지를 기동 에피소드로 본다 */
  readonly startSteadyLookupS: number;
  /** 연료전지 v_cell_at_jref 환산 기준 전류밀도 [A/cm²] */
  readonly jRefAcm2: number;
  /** 기준 전류밀도 근처 분극곡선 기울기 −dV/dj [V/(A/cm²)] */
  readonly polarizationSlopeVPerAcm2: number;
  /** |j − jRef|가 이보다 크면 환산하지 않는다 */
  readonly jRefMaxDistanceAcm2: number;
}

export const DEFAULT_STACK_EXTRACTOR_PARAMS: StackExtractorParams = Object.freeze({
  ...DEFAULT_STACK_RUN_RULES,
  jBinWidth: 0.1,
  tempBinWidthC: 5,
  fallbackPeriodS: 60,
  minCompleteness: 0.9,
  coldOffS: 7200,
  startSteadyLookupS: 7200,
  // 연료전지 정격(1 A/cm²급)의 부분부하 운전점 부근. 기울기는 옴·활성화 손실 구간의 일반적인 PEMFC 값 (실제 분극곡선이 오면 교체)
  jRefAcm2: 0.6,
  polarizationSlopeVPerAcm2: 0.2,
  jRefMaxDistanceAcm2: 0.3,
});

type SteadyCommon = {
  readonly j_mean: number;
  readonly i_mean: number;
  readonly v_cell_mean: number | null;
  readonly t_stack_mean: number | null;
  readonly h2_kg: number | null;
  readonly op_hours_cum: number | null;
  readonly duration_s: number;
};
export type ElSteadyFeatures = SteadyCommon & { readonly energy_kwh: number | null; readonly dc_kwh: number | null; readonly sec_kwh_per_kg: number | null };
export type FcSteadyFeatures = SteadyCommon & {
  readonly v_cell_at_jref: number | null;
  readonly ac_kwh: number | null;
  readonly kg_per_mwh: number | null;
  readonly blower_power_mean: number | null;
};
export type StackSteadyConditions = { readonly j_bin: number; readonly t_bin: number | null };
export type StackStartFeatures = { readonly off_duration_s: number | null; readonly time_to_steady_s: number | null; readonly start_count_delta: number | null };
export type StackStartConditions = { readonly cold: boolean | null };

export type ElSteadyEpisode = Episode<'el.steady_run', ElSteadyFeatures, StackSteadyConditions>;
export type FcSteadyEpisode = Episode<'fc.steady_run', FcSteadyFeatures, StackSteadyConditions>;
export type ElStartEpisode = Episode<'el.start', StackStartFeatures, StackStartConditions>;
export type FcStartEpisode = Episode<'fc.start', StackStartFeatures, StackStartConditions>;

interface MetricPoints {
  readonly points: readonly TimedValue[];
  readonly periodMs: number;
}

interface Context {
  readonly input: ExtractInput<StackNameplate>;
  readonly params: StackExtractorParams;
  readonly current: readonly TimedValue[];
  readonly periodMs: number;
  /** 메트릭별 good 샘플 (구간마다 전체 시계열을 다시 거르지 않도록 한 번만 만든다) */
  readonly metric: (key: string) => MetricPoints;
}

const SLOW_FALLBACK_MS = 5 * MS_PER_MINUTE;

function contextOf(input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams>): Context {
  const { cell_count: cells, active_area_cm2: area, rated_current_a: rated } = input.nameplate;
  if (!(cells > 0 && area > 0 && rated > 0)) throw new RangeError('스택 추출: 명판(cell_count, active_area_cm2, rated_current_a)이 올바르지 않습니다');
  const params = { ...DEFAULT_STACK_EXTRACTOR_PARAMS, ...overrides };
  const current = pointsIn(goodPoints(input.series, 'stack.current'), input.window);
  const cache = new Map<string, MetricPoints>();
  const metric = (key: string): MetricPoints => {
    const cached = cache.get(key);
    if (cached) return cached;
    const points = goodPoints(input.series, key);
    const entry = { points, periodMs: nominalPeriodMs(points, SLOW_FALLBACK_MS) };
    cache.set(key, entry);
    return entry;
  };
  return { input, params, current, periodMs: nominalPeriodMs(current, params.fallbackPeriodS * MS_PER_SECOND), metric };
}

function integralOf(ctx: Context, metric: string, w: SteadyWindow): number | null {
  const { points, periodMs } = ctx.metric(metric);
  const value = rangeIntegral(points, w, periodMs);
  return roundOrNull(value, 4);
}

function steadyCommon(ctx: Context, w: SteadyWindow): { features: SteadyCommon; dq: EpisodeDq } {
  const { series, nameplate } = ctx.input;
  const voltage = meanValue(pointsIn(ctx.metric('stack.voltage').points, w));
  const iMean = meanValue(pointsIn(ctx.current, w)) ?? w.meanCurrentA;
  const midpoint = (w.start + w.end) / 2;
  return {
    features: {
      j_mean: round(iMean / nameplate.active_area_cm2, 5),
      i_mean: round(iMean, 3),
      v_cell_mean: roundOrNull(voltage === null ? null : voltage / nameplate.cell_count, 6),
      t_stack_mean: roundOrNull(meanValue(pointsIn(ctx.metric('stack.temp').points, w)), 3),
      h2_kg: null,
      op_hours_cum: roundOrNull(valueNear(ctx.metric('run.hours').points, midpoint, 15 * MS_PER_MINUTE), 3),
      duration_s: (w.end - w.start) / MS_PER_SECOND,
    },
    dq: worstDq(['stack.current', 'stack.voltage'].map((m) => metricDq(series[m], w, ctx.periodMs))),
  };
}

function steadyEpisode<K extends 'el.steady_run' | 'fc.steady_run', F extends SteadyCommon>(ctx: Context, kind: K, w: SteadyWindow, features: F, dq: EpisodeDq): Episode<K, F, StackSteadyConditions> {
  return {
    assetId: ctx.input.assetId,
    kind,
    extractorVersion: extractorId(kind),
    start: w.start,
    end: w.end,
    features,
    conditions: {
      j_bin: binFloor(features.j_mean, ctx.params.jBinWidth),
      t_bin: features.t_stack_mean === null ? null : binFloor(features.t_stack_mean, ctx.params.tempBinWidthC),
    },
    dq,
    open: w.open,
    ...validity(w.open, dq.completeness, ctx.params.minCompleteness),
  };
}

const ratio = (numerator: number | null, denominator: number | null, scale = 1): number | null =>
  numerator === null || denominator === null || !(denominator > 0) ? null : round((numerator / denominator) * scale, 4);

function windowsOf(ctx: Context): SteadyWindow[] {
  return steadyWindows(ctx.current, ctx.input.window, ctx.input.nameplate.rated_current_a, ctx.periodMs, ctx.params);
}

/** 원시 샘플 → el.steady_run 에피소드 */
export function extractElSteadyRuns(input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams> = {}): ElSteadyEpisode[] {
  const ctx = contextOf(input, overrides);
  const voltage = ctx.metric('stack.voltage').points;
  return windowsOf(ctx).map((w) => {
    const { features: common, dq } = steadyCommon(ctx, w);
    const h2 = integralOf(ctx, 'h2.flow.mass', w);
    const energy = integralOf(ctx, 'ac.power', w);
    const dcWh = rangeIntegral(
      pointsIn(ctx.current, w).flatMap((p) => {
        const v = valueNear(voltage, p.ts, 2 * ctx.periodMs);
        return v === null ? [] : [{ ts: p.ts, value: p.value * v }];
      }),
      w,
      ctx.periodMs,
    );
    const features: ElSteadyFeatures = { ...common, h2_kg: h2, energy_kwh: energy, dc_kwh: roundOrNull(dcWh === null ? null : dcWh / 1000, 4), sec_kwh_per_kg: ratio(energy, h2) };
    return steadyEpisode(ctx, 'el.steady_run', w, features, dq);
  });
}

/** 원시 샘플 → fc.steady_run 에피소드 */
export function extractFcSteadyRuns(input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams> = {}): FcSteadyEpisode[] {
  const ctx = contextOf(input, overrides);
  const { jRefAcm2, polarizationSlopeVPerAcm2, jRefMaxDistanceAcm2 } = ctx.params;
  const blower = ctx.metric('blower.power').points;
  return windowsOf(ctx).map((w) => {
    const { features: common, dq } = steadyCommon(ctx, w);
    const h2 = integralOf(ctx, 'fc.h2.consumption', w);
    const acKwh = integralOf(ctx, 'fc.ac.power', w);
    const near = Math.abs(common.j_mean - jRefAcm2) <= jRefMaxDistanceAcm2;
    const vAtRef = common.v_cell_mean !== null && near ? common.v_cell_mean + polarizationSlopeVPerAcm2 * (common.j_mean - jRefAcm2) : null;
    const blowerMean = meanValue(pointsIn(blower, w)) ?? valueNear(blower, (w.start + w.end) / 2, SLOW_FALLBACK_MS);
    const features: FcSteadyFeatures = {
      ...common,
      h2_kg: h2,
      v_cell_at_jref: roundOrNull(vAtRef, 6),
      ac_kwh: acKwh,
      kg_per_mwh: ratio(h2, acKwh, 1000),
      blower_power_mean: roundOrNull(blowerMean, 3),
    };
    return steadyEpisode(ctx, 'fc.steady_run', w, features, dq);
  });
}

function extractStarts<K extends 'el.start' | 'fc.start'>(kind: K, input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams>): Episode<K, StackStartFeatures, StackStartConditions>[] {
  const ctx = contextOf(input, overrides);
  const windows = windowsOf(ctx);
  const counts = ctx.metric('start.count').points;
  return startEvents(ctx.current, input.nameplate.rated_current_a, ctx.params).map((event) => {
    const steady = windows.find((w) => w.start >= event.ts && w.start - event.ts <= ctx.params.startSteadyLookupS * MS_PER_SECOND);
    const end = steady && steady.start > event.ts ? steady.start : event.ts + ctx.periodMs;
    const before = valueAtOrBefore(counts, event.ts - 1, MS_PER_HOUR);
    const after = valueNear(counts, end, 15 * MS_PER_MINUTE);
    const range = { start: event.ts, end };
    const dq = metricDq(input.series['stack.current'], range, ctx.periodMs);
    return {
      assetId: input.assetId,
      kind,
      extractorVersion: extractorId(kind),
      start: event.ts,
      end,
      features: {
        off_duration_s: event.offMs === null ? null : event.offMs / MS_PER_SECOND,
        time_to_steady_s: steady ? (steady.start - event.ts) / MS_PER_SECOND : null,
        start_count_delta: before === null || after === null ? null : after - before,
      },
      conditions: { cold: event.offMs === null ? null : event.offMs >= ctx.params.coldOffS * MS_PER_SECOND },
      dq,
      open: false,
      ...validity(false, 1, 0),
    };
  });
}

export const extractElStarts = (input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams> = {}): ElStartEpisode[] => extractStarts('el.start', input, overrides);
export const extractFcStarts = (input: ExtractInput<StackNameplate>, overrides: Partial<StackExtractorParams> = {}): FcStartEpisode[] => extractStarts('fc.start', input, overrides);
