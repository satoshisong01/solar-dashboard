// el.voltage_rise@1 (전해조 셀 전압 상승률) · fc.voltage_decay@1 (연료전지 기준 전류밀도 셀 전압 감소율). 단위 µV/h/셀.
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import type { JsonObject } from '../types';
import { fixed, insufficient, r, severityByMagnitude, withDefaults } from './common';
import { earlyLateMedians, stackTrendEvidence, stackVoltageTrend, type StackPoint, type StackTrendParams, type StackTrendResult } from './stack-voltage';
import type { CandidateFinding, CheckStatus, Detector, DetectorContext, DetectorResult, DiagnosticCheck, FailureMode } from './types';

export interface StackDetectorParams extends StackTrendParams {
  readonly sev2UvPerH: number;
  readonly sev3UvPerH: number;
  readonly sev4UvPerH: number;
  /** 온도 분포가 이만큼 달라지면 온도 영향 체크 지지 [°C] */
  readonly tempShiftC: number;
  /** 블로워 전력이 이 비율 이상 늘면 블로워 체크 지지 [%] (연료전지) */
  readonly blowerRisePct: number;
}

const BASE_DEFAULTS = {
  minPerBin: 5,
  minTotal: 15,
  minSpanHours: 100,
  minCompleteness: 0.9,
  maxPoints: 400,
  cusumK: 0.5,
  cusumH: 5,
  sigmaFloorMv: 0.5,
  sev2UvPerH: 10,
  sev3UvPerH: 20,
  sev4UvPerH: 40,
  tempShiftC: 3,
  blowerRisePct: 10,
} as const;

export const EL_VOLTAGE_RISE_DEFAULTS: StackDetectorParams = Object.freeze({ ...BASE_DEFAULTS, breakInHours: 1000 });
export const FC_VOLTAGE_DECAY_DEFAULTS: StackDetectorParams = Object.freeze({ ...BASE_DEFAULTS, breakInHours: 500 });

export interface StackVoltageInput<E> {
  readonly assetId: number;
  readonly episodes: readonly E[];
}

interface Spec {
  readonly id: string;
  readonly failureMode: FailureMode;
  readonly direction: 'up' | 'down';
  readonly titleVerb: string;
  readonly subject: string;
}

const EL_SPEC: Spec = { id: 'el.voltage_rise', failureMode: 'el.stack_voltage_degradation', direction: 'up', titleVerb: '상승', subject: '셀 평균 전압' };
const FC_SPEC: Spec = { id: 'fc.voltage_decay', failureMode: 'fc.stack_voltage_decay', direction: 'down', titleVerb: '감소', subject: '기준 전류밀도 셀 전압' };

function toPoint(episode: ElSteadyEpisode | FcSteadyEpisode, voltage: number | null, from: number, now: number): StackPoint[] {
  const f = episode.features;
  if (!episode.valid || voltage === null || f.op_hours_cum === null || episode.start < from || episode.end > now) return [];
  return [{ start: episode.start, opHours: f.op_hours_cum, jMean: f.j_mean, jBin: episode.conditions.j_bin, tMean: f.t_stack_mean, tBin: episode.conditions.t_bin, voltage, completeness: episode.dq.completeness }];
}

function statusByChange(changePct: number | null, supportAt: number, refuteBelow: number): CheckStatus {
  if (changePct === null) return 'no_data';
  if (changePct >= supportAt) return 'supports';
  return changePct <= refuteBelow ? 'refutes' : 'unknown';
}

function temperatureCheck(result: StackTrendResult, p: StackDetectorParams): DiagnosticCheck {
  const temps = earlyLateMedians(result.points.flatMap((pt) => (pt.tMean === null ? [] : [{ x: pt.opHours, y: pt.tMean }])));
  const shift = temps === null ? null : Math.abs(temps.late - temps.early);
  const status = statusByChange(shift, p.tempShiftC, 1);
  const note = status === 'supports' ? '운전 온도 분포가 달라졌습니다. 온도 구간으로 보정했지만 영향이 남았을 수 있습니다.' : status === 'no_data' ? '스택 온도 데이터가 부족합니다.' : '운전 온도 분포는 크게 달라지지 않았습니다.';
  return { id: 'stack_temperature_shift', label: '운전 온도 변화', status, measured: { early_c: r(temps?.early ?? null, 2), late_c: r(temps?.late ?? null, 2) }, note };
}

function blowerCheck(episodes: readonly FcSteadyEpisode[], result: StackTrendResult, p: StackDetectorParams): DiagnosticCheck {
  const used = new Set(result.points.map((pt) => pt.start));
  const values = episodes.flatMap((e) => (used.has(e.start) && e.features.blower_power_mean !== null && e.features.op_hours_cum !== null ? [{ x: e.features.op_hours_cum, y: e.features.blower_power_mean }] : []));
  const halves = earlyLateMedians(values);
  const risePct = halves === null || !(halves.early > 0) ? null : (halves.late / halves.early - 1) * 100;
  const status = statusByChange(risePct, p.blowerRisePct, 2);
  const note = status === 'supports' ? '같은 운전 조건에서 블로워 전력이 늘었습니다. 공기 공급(블로워·흡입필터) 문제가 전압 감소와 함께 있을 수 있습니다.' : status === 'no_data' ? '블로워 전력 데이터가 부족합니다.' : '블로워 전력 증가는 뚜렷하지 않습니다.';
  return { id: 'blower_power_increase', label: '블로워 전력 증가 동반', status, measured: { early_kw: r(halves?.early ?? null, 3), late_kw: r(halves?.late ?? null, 3), rise_pct: r(risePct, 2) }, note };
}

function buildFinding(spec: Spec, input: StackVoltageInput<unknown>, ctx: DetectorContext<StackDetectorParams>, p: StackDetectorParams, result: StackTrendResult, checks: readonly DiagnosticCheck[]): CandidateFinding | null {
  const { fit } = result.trend;
  const sign = spec.direction === 'up' ? 1 : -1;
  const rate = sign * fit.slope * 1e6;
  const [ciLow, ciHigh] = spec.direction === 'up' ? [fit.ciLow * 1e6, fit.ciHigh * 1e6] : [-fit.ciHigh * 1e6, -fit.ciLow * 1e6];
  const severity = severityByMagnitude(rate, [[p.sev4UvPerH, 4], [p.sev3UvPerH, 3], [p.sev2UvPerH, 2]]);
  if (severity === null || !(ciLow > 0) || rate <= p.sev2UvPerH) return null;

  const first = result.xs[0] ?? 0;
  const last = result.xs[result.xs.length - 1] ?? 0;
  const baselineMv = (result.referenceV + fit.intercept + fit.slope * first) * 1000;
  const currentMv = (result.referenceV + fit.intercept + fit.slope * last) * 1000;
  const agrees = (result.trend.mkPValue < 0.05 && Math.sign(result.trend.mkTau) === sign) || result.trend.alarmIndex !== null;
  const evidence: JsonObject = { ...stackTrendEvidence(result, p.breakInHours), checks: [...checks] };
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  return {
    detectorId: spec.id,
    detectorVersion: '1',
    assetId: input.assetId,
    failureMode: spec.failureMode,
    category: 'degradation',
    severity,
    confidence: scoreConfidence({ n: result.points.length, ciWidth: relativeCiWidth(rate, ciLow, ciHigh), dqCompleteness: median(result.points.map((pt) => pt.completeness)), methodsAgree: agrees }),
    title: `스택 ${spec.subject} ${spec.titleVerb} ${fixed(rate, 1)} µV/h`,
    summary:
      `정상운전 ${result.points.length}구간(누적 ${fixed(first, 0)}~${fixed(last, 0)} h, break-in ${fixed(p.breakInHours, 0)} h 이후)을 같은 전류밀도·온도 구간으로 맞춰 보면 ` +
      `${spec.subject}이 ${fixed(rate, 1)} µV/h(95% CI ${fixed(ciLow, 1)} ~ ${fixed(ciHigh, 1)})로 ${spec.titleVerb}하고 있습니다. ` +
      `운전 ${fixed(last - first, 0)} h 동안 셀당 약 ${fixed(Math.abs(currentMv - baselineMv), 1)} mV ${spec.titleVerb}.` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: spec.direction === 'up' ? 'v_cell_rise_rate' : 'v_cell_decay_rate', value: r(rate, 3) ?? 0, unit: 'µV/h', ciLow: r(ciLow, 3), ciHigh: r(ciHigh, 3), baseline: r(baselineMv, 2), current: r(currentMv, 2), levelUnit: 'mV' },
    windowStart: Math.min(...result.points.map((pt) => pt.start)),
    windowEnd: Math.max(...result.points.map((pt) => pt.start)),
    evidence,
    inputHash: hashInput({ detector: `${spec.id}@1`, params: p, points: result.points.map((pt) => [pt.start, pt.opHours, pt.jMean, pt.tMean, pt.voltage]) }),
  };
}

function runStack<E extends ElSteadyEpisode | FcSteadyEpisode>(spec: Spec, defaults: StackDetectorParams, voltageOf: (e: E) => number | null, extraChecks: (episodes: readonly E[], result: StackTrendResult, p: StackDetectorParams) => DiagnosticCheck[]) {
  return (input: StackVoltageInput<E>, ctx: DetectorContext<StackDetectorParams>): DetectorResult => {
    const p = withDefaults(defaults, ctx.params);
    const from = ctx.baselineResetAt ?? -Infinity;
    const points = input.episodes.flatMap((e) => toPoint(e, voltageOf(e), from, ctx.now));
    const outcome = stackVoltageTrend(points, p, spec.direction);
    if (!outcome.ok) return insufficient(outcome.reason);
    const checks = [temperatureCheck(outcome.result, p), ...extraChecks(input.episodes, outcome.result, p)];
    const finding = buildFinding(spec, input, ctx, p, outcome.result, checks);
    return { status: 'ok', findings: finding ? [finding] : [] };
  };
}

export const elVoltageRise: Detector<StackVoltageInput<ElSteadyEpisode>, StackDetectorParams> = {
  id: EL_SPEC.id,
  version: '1',
  failureMode: EL_SPEC.failureMode,
  category: 'degradation',
  requires: { assetClass: ['h2.elz.stack'], metrics: ['stack.current', 'stack.voltage', 'stack.temp', 'run.hours'] },
  defaultParams: EL_VOLTAGE_RISE_DEFAULTS,
  detect: runStack<ElSteadyEpisode>(EL_SPEC, EL_VOLTAGE_RISE_DEFAULTS, (e) => e.features.v_cell_mean, () => []),
};

export const fcVoltageDecay: Detector<StackVoltageInput<FcSteadyEpisode>, StackDetectorParams> = {
  id: FC_SPEC.id,
  version: '1',
  failureMode: FC_SPEC.failureMode,
  category: 'degradation',
  requires: { assetClass: ['fc.stack'], metrics: ['stack.current', 'stack.voltage', 'stack.temp', 'run.hours', 'blower.power'] },
  defaultParams: FC_VOLTAGE_DECAY_DEFAULTS,
  detect: runStack<FcSteadyEpisode>(FC_SPEC, FC_VOLTAGE_DECAY_DEFAULTS, (e) => e.features.v_cell_at_jref ?? e.features.v_cell_mean, (episodes, result, p) => [blowerCheck(episodes, result, p)]),
};
