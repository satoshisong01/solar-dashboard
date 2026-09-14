// ess.capacity_fade@1 — 앵커 충전 세션의 유효용량을 기준 창 vs 최근 30일, 같은 C-rate×셀온도 bin으로 비교 (설계 §3.1).
import type { EssChargeEpisode } from '../episodes/ess';
import type { ChargeCurvePoint } from '../episodes/ess-features';
import { downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { matchedRatio, type MatchedRatioOk } from '../stats/matched';
import { median } from '../stats/robust';
import { trendValueAt } from '../stats/trend';
import { DAYS_PER_MONTH, MS_PER_DAY, type JsonObject } from '../types';
import { dailyMedians, dateKo, fixed, hoursKo, insufficient, r, severityByMagnitude, signed, summarizeTrend, withDefaults } from './common';
import { capacityChecks, type CapacityCheckParams } from './ess-capacity-checks';
import type { AssetEventInput, CandidateFinding, Detector, DetectorContext, DetectorResult } from './types';

export interface EssCapacityInput {
  readonly assetId: number;
  readonly ratedCapacityAh: number;
  readonly commissionedAt: number | null;
  /** ess.charge 에피소드 (앵커·보조 용량이 없는 세션도 넣어도 된다) */
  readonly sessions: readonly EssChargeEpisode[];
  readonly events: readonly AssetEventInput[];
  /** 대표 세션 충전 곡선 (chargeCurve 결과). 없으면 오버레이를 생략한다 */
  readonly curves?: readonly { readonly start: number; readonly points: readonly ChargeCurvePoint[] }[];
}

export interface EssCapacityParams extends CapacityCheckParams {
  readonly referenceSessions: number;
  readonly recentDays: number;
  /** 같은 조건 bin 폭: C-rate [C]·셀 온도 [°C]. 에피소드 features(i_mean_c·t_cell_mean)로 다시 나누므로 재추출 없이 설정으로 바꿀 수 있다 */
  readonly cRateBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minPerBin: number;
  readonly minTotal: number;
  readonly iterations: number;
  readonly minCompleteness: number;
  /** 앵커 세션이 모자라면 CC 구간 Ah 보조 용량(capacity_ah_cc)으로 비교 */
  readonly useCcAhFallback: boolean;
  /** 그래도 모자라면 부분 충전 쿨롱 카운팅 용량(capacity_ah_soc = 충전 Ah ÷ SOC 변화)으로 비교 */
  readonly useSocSpanFallback: boolean;
  readonly sev2Pct: number;
  readonly sev3Pct: number;
  readonly sev4Pct: number;
  readonly sohTargetPct: number;
  /** 충전시간 환산 기준 전류 [A]. null이면 기준 세션 CC 전류 중앙값 */
  readonly referenceCurrentA: number | null;
  readonly cusumK: number;
  readonly cusumH: number;
  /** CUSUM σ 하한 (기준 용량 대비 %) */
  readonly sigmaFloorPct: number;
}

export const ESS_CAPACITY_DEFAULTS: EssCapacityParams = Object.freeze({
  referenceSessions: 20,
  // sim:eval 게이트(5% 이상 탐지 지연 ≤ 21일)에 맞춰 30일 → 21일, bin당 5 → 3 (합계 15는 유지). 조정 근거는 scorecard.json params_note
  recentDays: 21,
  cRateBinWidth: 0.05,
  tempBinWidthC: 5,
  minPerBin: 3,
  minTotal: 15,
  iterations: 1000,
  minCompleteness: 0.95,
  useCcAhFallback: true,
  useSocSpanFallback: true,
  sev2Pct: -3,
  sev3Pct: -5,
  sev4Pct: -10,
  sohTargetPct: 80,
  referenceCurrentA: null,
  cusumK: 0.5,
  cusumH: 5,
  sigmaFloorPct: 0.5,
  coldShiftC: 3,
  socSetpointShiftPct: 2,
  ccAhDropPct: 2,
  cvTimeRisePct: 10,
  cellDvRiseMv: 10,
  socJumpPct: 3,
  socJumpShareRise: 0.2,
});

const META = { id: 'ess.capacity_fade', version: '1', failureMode: 'ess.capacity_fade', category: 'degradation' } as const;

type CapacityMetric = 'capacity_ah_anchored' | 'capacity_ah_cc' | 'capacity_ah_soc';

const METRIC_NOTES: Readonly<Record<CapacityMetric, string>> = {
  capacity_ah_anchored: '',
  capacity_ah_cc: ' 앵커 세션이 부족해 CC 구간 Ah 보조 지표로 비교했습니다.',
  capacity_ah_soc: ' 앵커·CC 세션이 부족해 충전 Ah ÷ SOC 변화(부분 충전 쿨롱 카운팅)로 비교했습니다. BMS SOC 재보정 여부를 함께 확인하세요.',
};

interface Selection {
  readonly metric: CapacityMetric;
  readonly reference: readonly EssChargeEpisode[];
  readonly recent: readonly EssChargeEpisode[];
  readonly all: readonly EssChargeEpisode[];
}

const valueOf = (metric: CapacityMetric) => (s: EssChargeEpisode): number => s.features[metric] ?? Number.NaN;
const binOf = (value: number, width: number): number => Math.round(Math.floor(value / width + 1e-9) * width * 1e6) / 1e6;
const binKeyOf = (p: Pick<EssCapacityParams, 'cRateBinWidth' | 'tempBinWidthC'>) => (s: EssChargeEpisode): string =>
  `${binOf(s.features.i_mean_c, p.cRateBinWidth)}|${s.features.t_cell_mean === null ? 'na' : binOf(s.features.t_cell_mean, p.tempBinWidthC)}`;

function baselineStart(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>): number {
  const resets = input.events.filter((e) => e.resetsBaseline && e.ts <= ctx.now).map((e) => e.ts);
  return Math.max(input.commissionedAt ?? -Infinity, ctx.baselineResetAt ?? -Infinity, ...resets);
}

function select(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>, p: EssCapacityParams, metric: CapacityMetric): Selection {
  const from = baselineStart(input, ctx);
  const all = input.sessions
    .filter((s) => s.valid && s.start >= from && s.end <= ctx.now && s.dq.completeness >= p.minCompleteness && Number.isFinite(valueOf(metric)(s)))
    .sort((a, b) => a.start - b.start);
  const window = ctx.referenceWindow;
  const reference = window && window.end > from ? all.filter((s) => s.start >= window.start && s.start < window.end) : all.slice(0, p.referenceSessions);
  const referenceEnd = reference[reference.length - 1]?.start ?? Infinity;
  const recent = all.filter((s) => s.start > referenceEnd && s.start >= ctx.now - p.recentDays * MS_PER_DAY);
  return { metric, reference, recent, all };
}

function curveFor(input: EssCapacityInput, sessions: readonly EssChargeEpisode[], metric: CapacityMetric): JsonObject | null {
  if (sessions.length === 0) return null;
  const center = median(sessions.map(valueOf(metric)));
  const representative = [...sessions].sort((a, b) => Math.abs(valueOf(metric)(a) - center) - Math.abs(valueOf(metric)(b) - center))[0];
  const curve = input.curves?.find((c) => c.start === representative?.start);
  if (!representative || !curve) return null;
  return {
    start: representative.start,
    capacity_ah: r(valueOf(metric)(representative), 2),
    points: downsample(curve.points, 120).map((pt) => ({ elapsed_s: pt.elapsed_s, ah: r(pt.ah, 2), soc: r(pt.soc, 2) })),
  };
}

function trendEvidence(sel: Selection, input: EssCapacityInput, p: EssCapacityParams, baselineAh: number) {
  const daily = dailyMedians(sel.all.map((s) => ({ ts: s.start, value: (valueOf(sel.metric)(s) / input.ratedCapacityAh) * 100 })));
  const t0 = daily[0]?.ts ?? 0;
  const xs = daily.map((d) => (d.ts - t0) / MS_PER_DAY);
  const ys = daily.map((d) => d.value);
  const summary = summarizeTrend(xs, ys, { referenceCount: sel.reference.length, sigmaFloor: (p.sigmaFloorPct / 100) * (baselineAh / input.ratedCapacityAh) * 100, direction: 'down', k: p.cusumK, h: p.cusumH });
  if (!summary) return { json: null, agrees: null };
  const { fit } = summary;
  const reachDay = (slope: number) => (slope < 0 ? t0 + (median(xs) + (p.sohTargetPct - median(ys)) / slope) * MS_PER_DAY : null);
  const changeTs = summary.changeStartIndex === null ? null : (daily[summary.changeStartIndex]?.ts ?? null);
  const json: JsonObject = {
    slope_pct_per_month: r(fit.slope * DAYS_PER_MONTH, 3),
    ci_low_pct_per_month: r(fit.ciLow * DAYS_PER_MONTH, 3),
    ci_high_pct_per_month: r(fit.ciHigh * DAYS_PER_MONTH, 3),
    mann_kendall_p: r(summary.mkPValue, 4),
    change_start: changeTs,
    soh_target_pct: p.sohTargetPct,
    soh_target_date: { estimate: reachDay(fit.slope), early: reachDay(fit.ciLow), late: fit.ciHigh < 0 ? reachDay(fit.ciHigh) : null },
    points: downsample(daily, 120).map((d) => ({ t: d.ts, soh_pct: r(d.value, 3) })),
    line: [0, xs[xs.length - 1] ?? 0].map((x) => ({ t: t0 + x * MS_PER_DAY, soh_pct: r(trendValueAt(fit, x), 3) })),
  };
  return { json, agrees: fit.ciHigh < 0 || summary.alarmIndex !== null || (summary.mkPValue < 0.05 && summary.mkTau < 0) };
}

function buildFinding(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>, p: EssCapacityParams, sel: Selection, matched: MatchedRatioOk): CandidateFinding | null {
  const effectPct = (matched.ratio - 1) * 100;
  const ciLowPct = (matched.ciLow - 1) * 100;
  const ciHighPct = (matched.ciHigh - 1) * 100;
  const severity = severityByMagnitude(-effectPct, [[-p.sev4Pct, 4], [-p.sev3Pct, 3], [-p.sev2Pct, 2]]);
  if (severity === null || ciHighPct >= 0) return null;

  const usedBins = matched.bins.filter((b) => b.used);
  const baselineAh = usedBins.reduce((sum, b) => sum + (b.nCur / matched.nCur) * (b.medRef ?? 0), 0);
  const currentAh = baselineAh * matched.ratio;
  const referenceA = p.referenceCurrentA ?? median(sel.reference.map((s) => s.features.i_mean_c)) * input.ratedCapacityAh;
  const trend = trendEvidence(sel, input, p, baselineAh);
  const since = sel.reference[sel.reference.length - 1]?.end ?? ctx.now;
  const checks = capacityChecks(sel.reference, sel.recent, input.events, since, p);
  const dq = median([...sel.reference, ...sel.recent].map((s) => s.dq.completeness));
  const metricNote = METRIC_NOTES[sel.metric];
  const windowStart = sel.reference[0]?.start ?? ctx.now;
  const windowEnd = sel.recent[sel.recent.length - 1]?.end ?? ctx.now;
  const from = baselineStart(input, ctx);

  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: matched.nCur, ciWidth: relativeCiWidth(effectPct, ciLowPct, ciHighPct), dqCompleteness: dq, methodsAgree: trend.agrees }),
    title: `배터리 유효용량 ${fixed(Math.abs(effectPct), 1)}% 감소`,
    summary:
      `같은 조건 충전 ${matched.nCur}회 비교: 유효용량 ${fixed(baselineAh, 0)} Ah → ${fixed(currentAh, 0)} Ah(${signed(effectPct, 1)}%, 95% CI ${signed(ciLowPct, 1)} ~ ${signed(ciHighPct, 1)}%). ` +
      `${fixed(referenceA, 0)} A 기준 충전시간 약 ${hoursKo(baselineAh / referenceA)} → ${hoursKo(currentAh / referenceA)}.${metricNote}`,
    effect: { metric: sel.metric, value: r(effectPct, 3) ?? 0, unit: '%', ciLow: r(ciLowPct, 3), ciHigh: r(ciHighPct, 3), baseline: r(baselineAh, 2), current: r(currentAh, 2), levelUnit: 'Ah' },
    windowStart,
    windowEnd,
    evidence: {
      method: 'matched_ratio',
      metric: sel.metric,
      reference: { n: sel.reference.length, from: windowStart, to: since },
      recent: { n: sel.recent.length, from: sel.recent[0]?.start ?? null, to: windowEnd },
      bins: matched.bins.map((b) => ({ key: b.key, n_ref: b.nRef, n_cur: b.nCur, med_ref: r(b.medRef, 2), med_cur: r(b.medCur, 2), ratio: r(b.ratio, 4), used: b.used })),
      trend: trend.json,
      charge_time: { reference_current_a: r(referenceA, 1), baseline_hours: r(baselineAh / referenceA, 3), current_hours: r(currentAh / referenceA, 3) },
      overlay: { reference: curveFor(input, sel.reference, sel.metric), recent: curveFor(input, sel.recent, sel.metric) },
      checks,
      baseline_start: Number.isFinite(from) ? from : null,
      as_of: dateKo(ctx.now),
    },
    inputHash: hashInput({
      detector: `${META.id}@${META.version}`,
      params: p,
      metric: sel.metric,
      reference: sel.reference.map((s) => [s.start, valueOf(sel.metric)(s), binKeyOf(p)(s)]),
      recent: sel.recent.map((s) => [s.start, valueOf(sel.metric)(s), binKeyOf(p)(s)]),
    }),
  };
}

function detect(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>): DetectorResult {
  const p = withDefaults(ESS_CAPACITY_DEFAULTS, ctx.params);
  if (!(input.ratedCapacityAh > 0)) return insufficient('랙 정격 용량이 없습니다');
  const enough = (s: Selection) => s.reference.length >= p.minTotal && s.recent.length >= p.minTotal;
  const anchored = select(input, ctx, p, 'capacity_ah_anchored');
  const fallbacks: CapacityMetric[] = [...(p.useCcAhFallback ? (['capacity_ah_cc'] as const) : []), ...(p.useSocSpanFallback ? (['capacity_ah_soc'] as const) : [])];
  const selection = enough(anchored) ? anchored : (fallbacks.map((metric) => select(input, ctx, p, metric)).find(enough) ?? anchored);
  if (!enough(selection)) {
    return insufficient(`유효 충전 세션 부족: 기준 ${anchored.reference.length}회·최근 ${p.recentDays}일 ${anchored.recent.length}회 (각 ${p.minTotal}회 필요)`);
  }
  const matched = matchedRatio(selection.reference, selection.recent, binKeyOf(p), valueOf(selection.metric), { minPerBin: p.minPerBin, minTotal: p.minTotal, iterations: p.iterations, rng: ctx.rng });
  if (matched.status === 'insufficient') return insufficient(matched.reason);
  const finding = buildFinding(input, ctx, p, selection, matched);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const essCapacityFade: Detector<EssCapacityInput, EssCapacityParams> = {
  ...META,
  requires: { assetClass: ['ess.rack'], metrics: ['batt.current', 'batt.voltage', 'batt.soc', 'cell.temp.avg', 'cell.voltage.max', 'cell.voltage.min'] },
  defaultParams: ESS_CAPACITY_DEFAULTS,
  detect,
};
