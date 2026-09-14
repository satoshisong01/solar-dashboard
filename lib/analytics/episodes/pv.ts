// 태양광 인버터 일 에피소드: pv.day@1 (KST 하루 단위).
// 입력 메트릭: ac.power(kW, 필수) · ac.power.limit(%) · op.state · poa.irradiance(W/m², 사이트 기상 설비 값을 합쳐 넣는다)
import { MS_PER_DAY, MS_PER_SECOND, kstDateString, kstDayStart, type TimeWindow } from '../types';
import { goodPoints, holdIntegral, metricDq, nominalPeriodMs, pointsIn, round, roundOrNull, valueAtOrBefore, type TimedValue } from './series';
import { extractorId, validity, type Episode, type ExtractInput } from './types';

/** op.state 고장 코드 (lib/sim/events OP_STATE.FAULT와 같은 값) */
export const OP_STATE_FAULT = 5;

export interface InverterNameplate {
  readonly ac_kw: number;
  readonly dc_kwp: number;
}

export interface PvDayParams {
  /** 운전 판정: AC 출력 > 정격의 이 비율 */
  readonly runningFraction: number;
  /** 클리핑 판정: AC 출력 ≥ 정격의 이 비율이 2샘플 이상 이어짐 */
  readonly clippingFraction: number;
  readonly clippingFlagRatio: number;
  /** 일사 있음 판정 [W/m²] */
  readonly sunIrradiance: number;
  readonly curtailedFlagHours: number;
  readonly stoppedFlagHours: number;
  readonly maxGapS: number;
  readonly fallbackPeriodS: number;
  readonly limitToleranceS: number;
  readonly minCompleteness: number;
}

export const DEFAULT_PV_DAY_PARAMS: PvDayParams = Object.freeze({
  runningFraction: 0.01,
  clippingFraction: 0.99,
  clippingFlagRatio: 0.02,
  sunIrradiance: 50,
  curtailedFlagHours: 0.25,
  stoppedFlagHours: 0.5,
  maxGapS: 180,
  fallbackPeriodS: 60,
  limitToleranceS: 900,
  minCompleteness: 0.9,
});

export type PvDayFeatures = {
  readonly day: string;
  readonly energy_kwh: number;
  readonly kwh_per_kwp: number;
  readonly operating_h: number;
  readonly sun_h: number | null;
  readonly insolation_kwh_m2: number | null;
  /** 운전 시간 중 정격 99% 이상 평탄 구간 비율 */
  readonly clipping_ratio: number;
  /** 운전·일사 시간 중 출력 제한 설정 < 100% 시간 */
  readonly curtailed_h: number;
  /** 일사가 있는데(일사계 없으면 첫·마지막 운전 사이) 출력이 없던 시간 */
  readonly stopped_h: number;
  readonly trip_count: number;
};

export type PvDayConditions = {
  readonly curtailed: boolean;
  readonly clipping: boolean;
  readonly stopped: boolean;
};

export type PvDayEpisode = Episode<'pv.day', PvDayFeatures, PvDayConditions>;

/** 하루마다 전체 시계열을 다시 거르지 않도록 메트릭별 good 샘플을 한 번만 만든다 */
interface Signals {
  readonly power: readonly TimedValue[];
  readonly poa: readonly TimedValue[];
  readonly poaPeriodMs: number;
  readonly limits: readonly TimedValue[];
  readonly states: readonly TimedValue[];
  readonly periodMs: number;
  readonly maxGapMs: number;
}

interface DayContext extends Signals {
  readonly day: TimeWindow;
}

function clippingHours(ctx: DayContext, levelKw: number): number {
  const points = pointsIn(ctx.power, ctx.day);
  const high = points.map((p) => p.value >= levelKw);
  const flat = new Set(points.filter((_, i) => high[i] && (high[i - 1] === true || high[i + 1] === true)).map((p) => p.ts));
  return holdIntegral(points, ctx.day, ctx.periodMs, ctx.maxGapMs, (p) => (flat.has(p.ts) ? 1 : 0));
}

function tripCount(states: readonly TimedValue[], day: TimeWindow): number {
  const points = pointsIn(states, day);
  return points.filter((p, i) => p.value === OP_STATE_FAULT && (i === 0 ? true : (points[i - 1] as TimedValue).value !== OP_STATE_FAULT)).length;
}

/** 일사가 있는 구간 판정 함수. 일사계가 없으면 그날 첫·마지막 운전 샘플 사이를 낮으로 본다 */
function daylightTest(ctx: DayContext, params: PvDayParams, runningKw: number): (ts: number) => boolean {
  const { poa } = ctx;
  if (poa.length > 0) return (ts) => (valueAtOrBefore(poa, ts, params.limitToleranceS * MS_PER_SECOND) ?? 0) >= params.sunIrradiance;
  const running = pointsIn(ctx.power, ctx.day).filter((p) => p.value > runningKw);
  const first = running[0]?.ts ?? Number.POSITIVE_INFINITY;
  const last = running[running.length - 1]?.ts ?? Number.NEGATIVE_INFINITY;
  return (ts) => ts >= first && ts <= last;
}

function dayFeatures(input: ExtractInput<InverterNameplate>, ctx: DayContext, params: PvDayParams): PvDayFeatures {
  const { ac_kw: acKw, dc_kwp: dcKwp } = input.nameplate;
  const runningKw = params.runningFraction * acKw;
  const integrate = (weight: (p: TimedValue) => number) => holdIntegral(ctx.power, ctx.day, ctx.periodMs, ctx.maxGapMs, weight);
  const isDaylight = daylightTest(ctx, params, runningKw);
  const limited = (ts: number) => (valueAtOrBefore(ctx.limits, ts, params.limitToleranceS * MS_PER_SECOND) ?? 100) < 99.5;
  const { poa, poaPeriodMs } = ctx;
  const energy = integrate((p) => Math.max(0, p.value));
  const operating = integrate((p) => (p.value > runningKw ? 1 : 0));
  return {
    day: kstDateString(ctx.day.start),
    energy_kwh: round(energy, 3),
    kwh_per_kwp: round(energy / dcKwp, 5),
    operating_h: round(operating, 3),
    sun_h: poa.length > 0 ? round(holdIntegral(poa, ctx.day, poaPeriodMs, 3 * poaPeriodMs, (p) => (p.value >= params.sunIrradiance ? 1 : 0)), 3) : null,
    insolation_kwh_m2: poa.length > 0 ? roundOrNull(holdIntegral(poa, ctx.day, poaPeriodMs, 3 * poaPeriodMs, (p) => Math.max(0, p.value)) / 1000, 3) : null,
    clipping_ratio: operating > 0 ? round(clippingHours(ctx, params.clippingFraction * acKw) / operating, 4) : 0,
    curtailed_h: round(integrate((p) => ((p.value > runningKw || isDaylight(p.ts)) && limited(p.ts) ? 1 : 0)), 3),
    stopped_h: round(integrate((p) => (isDaylight(p.ts) && p.value <= runningKw ? 1 : 0)), 3),
    trip_count: tripCount(ctx.states, ctx.day),
  };
}

/** 운전 구간(첫·마지막 운전 샘플) 기준 완결성. 운전이 없던 날은 하루 전체 기준 */
function dayCompleteness(input: ExtractInput<InverterNameplate>, ctx: DayContext, runningKw: number): number {
  const running = pointsIn(ctx.power, ctx.day).filter((p) => p.value > runningKw);
  const first = running[0];
  const last = running[running.length - 1];
  const range = first && last && last.ts > first.ts ? { start: first.ts, end: last.ts + ctx.periodMs } : ctx.day;
  return metricDq(input.series['ac.power'], range, ctx.periodMs).completeness;
}

/** 원시 샘플 → KST 일별 pv.day 에피소드. 창에 일부만 걸린 날은 open */
export function extractPvDays(input: ExtractInput<InverterNameplate>, overrides: Partial<PvDayParams> = {}): PvDayEpisode[] {
  const params = { ...DEFAULT_PV_DAY_PARAMS, ...overrides };
  if (!(input.nameplate.ac_kw > 0 && input.nameplate.dc_kwp > 0)) throw new RangeError('pv.day 추출: 인버터 정격(ac_kw, dc_kwp)이 올바르지 않습니다');
  const power = goodPoints(input.series, 'ac.power');
  if (power.length === 0) return [];
  const periodMs = nominalPeriodMs(power, params.fallbackPeriodS * MS_PER_SECOND);
  const poa = goodPoints(input.series, 'poa.irradiance');
  const signals: Signals = {
    power,
    poa,
    poaPeriodMs: nominalPeriodMs(poa, 300_000),
    limits: goodPoints(input.series, 'ac.power.limit'),
    states: goodPoints(input.series, 'op.state'),
    periodMs,
    maxGapMs: params.maxGapS * MS_PER_SECOND,
  };
  const firstDay = kstDayStart(input.window.start);
  const dayCount = Math.ceil((input.window.end - firstDay) / MS_PER_DAY);
  return Array.from({ length: dayCount }, (_, i): PvDayEpisode => {
    const day = { start: firstDay + i * MS_PER_DAY, end: firstDay + (i + 1) * MS_PER_DAY };
    const ctx: DayContext = { ...signals, day };
    const features = dayFeatures(input, ctx, params);
    const open = day.start < input.window.start || day.end > input.window.end;
    const completeness = dayCompleteness(input, ctx, params.runningFraction * input.nameplate.ac_kw);
    const dq = metricDq(input.series['ac.power'], day, periodMs);
    return {
      assetId: input.assetId,
      kind: 'pv.day',
      extractorVersion: extractorId('pv.day'),
      start: day.start,
      end: day.end,
      features,
      conditions: {
        curtailed: features.curtailed_h >= params.curtailedFlagHours,
        clipping: features.clipping_ratio >= params.clippingFlagRatio,
        stopped: features.trip_count > 0 || features.stopped_h >= params.stoppedFlagHours,
      },
      dq: { ...dq, completeness: round(completeness, 4) },
      open,
      ...validity(open, completeness, params.minCompleteness),
    };
  });
}
