// ess.capacity_fade@1 — 랙 유효용량을 기준 vs 최근 21일, 같은 조건 bin으로 비교 (설계 §3.1).
// 방식 우선순위: CV 종료 앵커 > 휴지 앵커(rest_anchored) > CC 구간 Ah > 부분 충전 SOC 변화. 앞 방식이 판정 불능이면 다음 방식.
// 기준은 bin별로 고른다 (ess-capacity-reference.ts). SOC 기반 방식은 BMS SOC 재보정 품질에 의존한다는 주의 코드를 근거에 남긴다.
import * as z from 'zod';
import type { EssChargeEpisode, EssDischargeEpisode, EssRestEpisode } from '../episodes/ess';
import { DEFAULT_ESS_EXTRACTOR_PARAMS } from '../episodes/ess';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { matchedRatio, type MatchedRatioOk, type MatchedRatioResult } from '../stats/matched';
import { median } from '../stats/robust';
import { MS_PER_DAY, type JsonObject } from '../types';
import { dateKo, fixed, hoursKo, insufficient, r, severityByMagnitude, signed, withDefaults } from './common';
import { capacityChecks, type CapacityCheckParams } from './ess-capacity-checks';
import { binsEvidence, curveFor, referenceCurrentA, trendEvidence, type CurveInput } from './ess-capacity-evidence';
import { splitReferenceRecent, type ReferenceSplit } from './ess-capacity-reference';
import { CAPACITY_METHOD_LABELS, CAPACITY_METHOD_ORDER, CAPACITY_SAMPLE_RULE_DEFAULTS, restPairSamples, sessionSamples, type CapacityMethod, type CapacitySample } from './ess-capacity-samples';
import { boolParam, completenessParam, intParam, iterationsParam, nullableNumParam, numParam } from './param-schema';
import { FAST_S, required, SLOW_S } from './requirements';
import type { AssetEventInput, CandidateFinding, Detector, DetectorContext, DetectorResult } from './types';

export interface EssCapacityInput {
  readonly assetId: number;
  readonly ratedCapacityAh: number;
  readonly commissionedAt: number | null;
  /** ess.charge 에피소드 (앵커·보조 용량이 없는 세션도 넣어도 된다) */
  readonly sessions: readonly EssChargeEpisode[];
  /** 휴지 앵커 방식용 ess.discharge·ess.rest 에피소드 (없으면 그 방식은 판정 불능) */
  readonly discharges?: readonly EssDischargeEpisode[];
  readonly rests?: readonly EssRestEpisode[];
  readonly events: readonly AssetEventInput[];
  /** 대표 세션 충전 곡선 (chargeCurve 결과). 없으면 오버레이를 생략한다 */
  readonly curves?: readonly CurveInput[];
}

export interface EssCapacityParams extends CapacityCheckParams {
  /** bin별 기준: bin마다 가장 이른 표본 수 */
  readonly referencePerBin: number;
  /** bin 기준 시점이 주 bin 기준 시점에서 이만큼 넘게 떨어지면 그 bin을 결합에서 뺀다 [일] */
  readonly maxReferenceSpreadDays: number;
  readonly recentDays: number;
  /** 같은 조건 bin 폭: C-rate [C]·셀 온도 [°C]. 에피소드 features(i_mean_c·t_cell_mean)로 다시 나누므로 재추출 없이 설정으로 바꿀 수 있다 */
  readonly cRateBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minPerBin: number;
  /** 최근 표본 합계 하한 (기준 합계 하한은 bin별 기준이면 referencePerBin, 기준 창이면 이 값) */
  readonly minTotal: number;
  readonly iterations: number;
  readonly minCompleteness: number;
  /** 휴지 앵커 방식: 휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC */
  readonly useRestAnchored: boolean;
  readonly restMinutes: number;
  readonly minDeltaSocRest: number;
  readonly socSigmaPct: number;
  readonly currentGainSigma: number;
  readonly restPairMaxHours: number;
  readonly restPairMinCoverage: number;
  /** 앵커·휴지 앵커가 모자라면 CC 구간 Ah 보조 용량(capacity_ah_cc)으로 비교 */
  readonly useCcAhFallback: boolean;
  /** 그래도 모자라면 부분 충전 쿨롱 카운팅 용량(capacity_ah_soc = 충전 Ah ÷ SOC 변화)으로 비교 */
  readonly useSocSpanFallback: boolean;
  readonly sev2Pct: number;
  readonly sev3Pct: number;
  readonly sev4Pct: number;
  readonly sohTargetPct: number;
  /** SOH 도달일 외삽을 쓰려면 필요한 데이터 기간 [일] (화면·리포트 표시 규칙) */
  readonly minSpanDaysForProjection: number;
  /** 충전시간 환산 기준 전류 [A]. null이면 기준 기간 충전 세션 CC 전류 중앙값 */
  readonly referenceCurrentA: number | null;
  readonly cusumK: number;
  readonly cusumH: number;
  /** CUSUM σ 하한 (기준 용량 대비 %) */
  readonly sigmaFloorPct: number;
}

export const ESS_CAPACITY_DEFAULTS: EssCapacityParams = Object.freeze({
  referencePerBin: 5,
  maxReferenceSpreadDays: 120,
  // sim:eval 게이트(5% 이상 탐지 지연 ≤ 21일)에 맞춰 30일 → 21일, bin당 5 → 3 (합계 15는 유지). 조정 근거는 scorecard.json params_note
  recentDays: 21,
  minPerBin: 3,
  minTotal: 15,
  iterations: 1000,
  // 표본 규칙(bin 폭·완결성·휴지 앵커)은 조치 효과 검증과 한 곳에서 공유한다
  ...CAPACITY_SAMPLE_RULE_DEFAULTS,
  useRestAnchored: true,
  useCcAhFallback: true,
  useSocSpanFallback: true,
  sev2Pct: -3,
  sev3Pct: -5,
  sev4Pct: -10,
  sohTargetPct: 80,
  minSpanDaysForProjection: 60,
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

const D = ESS_CAPACITY_DEFAULTS;
export const ESS_CAPACITY_PARAM_SCHEMA = z.object({
  referencePerBin: intParam(D.referencePerBin, { label: 'bin별 기준 표본 수', unit: '개', min: 2, max: 100, description: '조건 bin마다 가장 이른 이 수만큼의 표본을 그 bin의 기준으로 씁니다.' }),
  maxReferenceSpreadDays: numParam(D.maxReferenceSpreadDays, { label: 'bin 기준 시점 간격 상한', unit: '일', min: 1, max: 1000, description: 'bin 기준 시점이 주 bin 기준 시점에서 이만큼 넘게 떨어지면 그 bin을 결합에서 뺍니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 7, max: 180, description: '최근 표본을 모으는 기간입니다.' }),
  cRateBinWidth: numParam(D.cRateBinWidth, { label: 'C-rate bin 폭', unit: 'C', min: 0.005, max: 1, description: '같은 조건 비교에 쓰는 C-rate 구간 폭입니다.' }),
  tempBinWidthC: numParam(D.tempBinWidthC, { label: '셀 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '같은 조건 비교에 쓰는 셀 온도 구간 폭입니다.' }),
  minPerBin: intParam(D.minPerBin, { label: 'bin당 최소 표본', unit: '개', min: 1, max: 100, description: '기준·최근 모두 이 수 이상인 bin만 비교에 씁니다.' }),
  minTotal: intParam(D.minTotal, { label: '최근 표본 합계 하한', unit: '개', min: 3, max: 500, description: '사용한 bin의 최근 표본 합계가 이보다 적으면 판정 불능입니다.' }),
  iterations: iterationsParam(D.iterations),
  minCompleteness: completenessParam(D.minCompleteness),
  useRestAnchored: boolParam(D.useRestAnchored, { label: '휴지 앵커 방식 사용', description: '앵커 세션이 부족하면 휴지 끝 SOC 두 점 사이 순 Ah ÷ SOC 변화로 비교합니다.' }),
  restMinutes: numParam(D.restMinutes, { label: '휴지 앵커 최소 휴지', unit: '분', min: 5, max: 600, description: '휴지 앵커로 쓰려면 필요한 휴지 길이입니다.' }),
  minDeltaSocRest: numParam(D.minDeltaSocRest, { label: '휴지 앵커 최소 SOC 변화', unit: '%p', min: 5, max: 100, description: '두 휴지 끝 SOC 차이가 이 값 이상인 쌍만 씁니다.' }),
  socSigmaPct: numParam(D.socSigmaPct, { label: '휴지 끝 SOC 1σ', unit: '%p', min: 0.1, max: 10, description: '휴지 앵커 가중치(불확실도 역수) 계산에 쓰는 SOC 불확도입니다.' }),
  currentGainSigma: numParam(D.currentGainSigma, { label: '전류 적분 상대오차 1σ', unit: '', min: 0, max: 0.1, description: '휴지 앵커 가중치 계산에 쓰는 전류 적분 상대 오차입니다.' }),
  restPairMaxHours: numParam(D.restPairMaxHours, { label: '휴지 앵커 쌍 최대 길이', unit: 'h', min: 1, max: 240, description: '두 앵커 사이가 이보다 길면 쓰지 않습니다.' }),
  restPairMinCoverage: numParam(D.restPairMinCoverage, { label: '휴지 앵커 쌍 에피소드 덮음 비율', unit: '', min: 0.5, max: 1, description: '두 앵커 사이를 에피소드가 덮는 비율 하한입니다.' }),
  useCcAhFallback: boolParam(D.useCcAhFallback, { label: 'CC 구간 Ah 보조 방식 사용', description: '앵커·휴지 앵커가 모자라면 CC 구간 Ah 보조 용량으로 비교합니다.' }),
  useSocSpanFallback: boolParam(D.useSocSpanFallback, { label: 'SOC 변화 보조 방식 사용', description: '그래도 모자라면 충전 Ah ÷ SOC 변화로 비교합니다.' }),
  sev2Pct: numParam(D.sev2Pct, { label: 'severity 2 감소율', unit: '%', min: -100, max: 0, description: '유효용량 변화가 이 값 이하이고 CI 상한이 0 미만이면 finding(severity 2)입니다.' }),
  sev3Pct: numParam(D.sev3Pct, { label: 'severity 3 감소율', unit: '%', min: -100, max: 0, description: '이 값 이하이면 severity 3입니다.' }),
  sev4Pct: numParam(D.sev4Pct, { label: 'severity 4 감소율', unit: '%', min: -100, max: 0, description: '이 값 이하이면 severity 4입니다.' }),
  sohTargetPct: numParam(D.sohTargetPct, { label: 'SOH 목표', unit: '%', min: 50, max: 100, description: 'SOH 도달일 추정에 쓰는 정격 대비 목표입니다.' }),
  minSpanDaysForProjection: intParam(D.minSpanDaysForProjection, { label: 'SOH 도달일 외삽 최소 기간', unit: '일', min: 7, max: 730, description: '데이터 기간이 이보다 짧으면 도달일 대신 "추세 확인 중"으로 씁니다.' }),
  referenceCurrentA: nullableNumParam(D.referenceCurrentA, { label: '충전시간 환산 기준 전류', unit: 'A', min: 1, max: 10_000, description: '비우면 기준 기간 충전 세션 CC 전류 중앙값을 씁니다.' }),
  cusumK: numParam(D.cusumK, { label: 'CUSUM k', unit: 'σ', min: 0, max: 3, description: '표 CUSUM 허용 편차입니다.' }),
  cusumH: numParam(D.cusumH, { label: 'CUSUM h', unit: 'σ', min: 1, max: 20, description: '표 CUSUM 결정 경계입니다.' }),
  sigmaFloorPct: numParam(D.sigmaFloorPct, { label: 'CUSUM σ 하한', unit: '%', min: 0.01, max: 10, description: '기준 용량 대비 CUSUM σ 하한입니다.' }),
  coldShiftC: numParam(D.coldShiftC, { label: '저온 영향 기준', unit: '°C', min: 0.5, max: 30, description: '최근 셀 온도 중앙값이 기준보다 이만큼 낮으면 저온 영향 체크를 지지로 봅니다.' }),
  socSetpointShiftPct: numParam(D.socSetpointShiftPct, { label: 'SOC 상한 변경 기준', unit: '%p', min: 0.5, max: 50, description: '충전 종료 SOC 중앙값이 이만큼 낮아지면 SOC 상한 변경 체크를 지지로 봅니다.' }),
  ccAhDropPct: numParam(D.ccAhDropPct, { label: 'CC 구간 Ah 감소 기준', unit: '%', min: 0.5, max: 50, description: 'CC 구간 Ah가 이 비율 이상 줄고 CV 시간이 늘면 내부저항 체크를 지지로 봅니다.' }),
  cvTimeRisePct: numParam(D.cvTimeRisePct, { label: 'CV 시간 증가 기준', unit: '%', min: 1, max: 500, description: 'CV 시간이 이 비율 이상 늘면 내부저항 체크 조건을 채웁니다.' }),
  cellDvRiseMv: numParam(D.cellDvRiseMv, { label: '셀 전압 편차 증가 기준', unit: 'mV', min: 1, max: 200, description: '종료 셀 전압 편차가 이만큼 커지면 셀 불균형 동반 체크를 지지로 봅니다.' }),
  socJumpPct: numParam(D.socJumpPct, { label: 'SOC 재보정 점프 기준', unit: '%p', min: 0.5, max: 50, description: '충전 시작 SOC와 휴지 OCV SOC 차이가 이 값 이상이면 재보정 점프로 셉니다.' }),
  socJumpShareRise: numParam(D.socJumpShareRise, { label: '재보정 점프 비율 증가 기준', unit: '', min: 0.01, max: 1, description: '재보정 점프 세션 비율이 이만큼 늘면 BMS 재보정 체크를 지지로 봅니다.' }),
});

const META = { id: 'ess.capacity_fade', version: '1', failureMode: 'ess.capacity_fade', category: 'degradation' } as const;

/** SOC 기반 추정 주의 코드 (리포트·화면이 문구로 바꾼다) */
export const SOC_RECALIBRATION_CAUTION = 'soc_estimate_depends_on_bms_recalibration';

const METHOD_NOTES: Readonly<Record<CapacityMethod, string>> = {
  capacity_ah_anchored: '',
  rest_anchored: ' 앵커 세션이 부족해 휴지 끝 SOC 두 점 사이 순 Ah ÷ SOC 변화(휴지 앵커)로 비교했습니다. SOC 기반 추정은 BMS SOC 재보정 품질에 의존합니다.',
  capacity_ah_cc: ' 앵커 세션이 부족해 CC 구간 Ah 보조 지표로 비교했습니다. SOC 기반 추정은 BMS SOC 재보정 품질에 의존합니다.',
  capacity_ah_soc: ' 앵커·CC 세션이 부족해 충전 Ah ÷ SOC 변화(부분 충전 쿨롱 카운팅)로 비교했습니다. SOC 기반 추정은 BMS SOC 재보정 품질에 의존합니다.',
};

const METHOD_SUBJECT: Readonly<Record<CapacityMethod, string>> = { capacity_ah_anchored: '충전', rest_anchored: '휴지 앵커 쌍', capacity_ah_cc: '충전', capacity_ah_soc: '충전' };

interface Comparison {
  readonly method: CapacityMethod;
  readonly samples: readonly CapacitySample[];
  readonly split: ReferenceSplit;
  readonly matched: MatchedRatioResult;
}

function baselineStart(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>): number {
  const resets = input.events.filter((e) => e.resetsBaseline && e.ts <= ctx.now).map((e) => e.ts);
  return Math.max(input.commissionedAt ?? -Infinity, ctx.baselineResetAt ?? -Infinity, ...resets);
}

function enabled(method: CapacityMethod, p: EssCapacityParams): boolean {
  if (method === 'rest_anchored') return p.useRestAnchored;
  if (method === 'capacity_ah_cc') return p.useCcAhFallback;
  return method === 'capacity_ah_soc' ? p.useSocSpanFallback : true;
}

function samplesOf(method: CapacityMethod, input: EssCapacityInput, p: EssCapacityParams): CapacitySample[] {
  if (method !== 'rest_anchored') return sessionSamples(input.sessions, method, p);
  return restPairSamples(
    { ratedCapacityAh: input.ratedCapacityAh, charges: input.sessions, discharges: input.discharges ?? [], rests: input.rests ?? [] },
    { ...p, restThresholdC: DEFAULT_ESS_EXTRACTOR_PARAMS.thresholdC },
  );
}

function compare(method: CapacityMethod, input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>, p: EssCapacityParams): Comparison {
  const from = baselineStart(input, ctx);
  const samples = samplesOf(method, input, p).filter((s) => s.start >= from && s.end <= ctx.now).sort((a, b) => a.start - b.start);
  const window = ctx.referenceWindow && ctx.referenceWindow.end > from ? ctx.referenceWindow : undefined;
  const split = splitReferenceRecent(samples, { now: ctx.now, recentDays: p.recentDays, referencePerBin: p.referencePerBin, maxReferenceSpreadDays: p.maxReferenceSpreadDays, referenceWindow: window });
  const matched = matchedRatio(split.reference, split.recent, (s) => s.bin, (s) => s.value, {
    minPerBin: p.minPerBin,
    minTotal: p.minTotal,
    minTotalReference: split.mode === 'per_bin' ? Math.min(p.referencePerBin, p.minTotal) : p.minTotal,
    iterations: p.iterations,
    rng: ctx.rng,
    weightKey: (s) => s.weight,
  });
  return { method, samples, split, matched };
}

type OkComparison = Comparison & { readonly matched: MatchedRatioOk };

function methodsEvidence(comparisons: readonly Comparison[], p: EssCapacityParams): JsonObject {
  return Object.fromEntries(
    CAPACITY_METHOD_ORDER.map((method) => {
      const c = comparisons.find((item) => item.method === method);
      if (!enabled(method, p)) return [method, { status: 'disabled', samples: 0, reference: 0, recent: 0 }];
      if (!c) return [method, { status: 'not_evaluated', samples: 0, reference: 0, recent: 0 }];
      return [method, { status: c.matched.status, samples: c.samples.length, reference: c.matched.nRef, recent: c.matched.nCur }];
    }),
  );
}

function buildFinding(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>, p: EssCapacityParams, chosen: OkComparison, comparisons: readonly Comparison[]): CandidateFinding | null {
  const { matched, split, method } = chosen;
  const effectPct = (matched.ratio - 1) * 100;
  const ciLowPct = (matched.ciLow - 1) * 100;
  const ciHighPct = (matched.ciHigh - 1) * 100;
  const severity = severityByMagnitude(-effectPct, [[-p.sev4Pct, 4], [-p.sev3Pct, 3], [-p.sev2Pct, 2]]);
  if (severity === null || ciHighPct >= 0) return null;

  const usedBins = matched.bins.filter((b) => b.used);
  const baselineAh = usedBins.reduce((sum, b) => sum + b.weight * (b.medRef ?? 0), 0);
  const currentAh = baselineAh * matched.ratio;
  const usedRefs = split.bins.filter((b) => usedBins.some((u) => u.key === b.key));
  const refRanges = usedRefs.flatMap((b) => (b.refFrom === null || b.refTo === null ? [] : [{ from: b.refFrom, to: b.refTo }]));
  const referenceEnd = Math.max(...refRanges.map((range) => range.to));
  const earliestReferenceEnd = Math.min(...refRanges.map((range) => range.to));
  const recentFrom = ctx.now - p.recentDays * MS_PER_DAY;
  const refA = p.referenceCurrentA ?? referenceCurrentA(input.sessions, refRanges, input.ratedCapacityAh);
  const trend = trendEvidence(chosen.samples, referenceEnd, baselineAh, { ...p, ratedCapacityAh: input.ratedCapacityAh });
  const validSessions = input.sessions.filter((s) => s.valid && s.dq.completeness >= p.minCompleteness && s.end <= ctx.now);
  const refSessions = validSessions.filter((s) => refRanges.some((range) => s.start >= range.from && s.start <= range.to));
  const recentSessions = validSessions.filter((s) => s.start >= recentFrom);
  const checks = capacityChecks(refSessions, recentSessions, input.events, earliestReferenceEnd, p);
  const referenceSamples = split.reference.filter((s) => usedBins.some((b) => b.key === s.bin));
  const recentSamples = split.recent.filter((s) => usedBins.some((b) => b.key === s.bin));
  const dq = median([...referenceSamples, ...recentSamples].map((s) => s.completeness));
  const windowStart = Math.min(...refRanges.map((range) => range.from));
  const windowEnd = Math.max(...recentSamples.map((s) => s.end));
  const from = baselineStart(input, ctx);
  const chargeTime = refA === null || !(refA > 0) ? '' : ` ${fixed(refA, 0)} A 기준 충전시간 약 ${hoursKo(baselineAh / refA)} → ${hoursKo(currentAh / refA)}.`;

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
      `같은 조건 ${METHOD_SUBJECT[method]} ${matched.nCur}회 비교: 유효용량 ${fixed(baselineAh, 0)} Ah → ${fixed(currentAh, 0)} Ah(${signed(effectPct, 1)}%, 95% CI ${signed(ciLowPct, 1)} ~ ${signed(ciHighPct, 1)}%).` +
      `${chargeTime}${METHOD_NOTES[method]}`,
    effect: { metric: method, value: r(effectPct, 3) ?? 0, unit: '%', ciLow: r(ciLowPct, 3), ciHigh: r(ciHighPct, 3), baseline: r(baselineAh, 2), current: r(currentAh, 2), levelUnit: 'Ah' },
    windowStart,
    windowEnd,
    evidence: {
      method: 'matched_ratio',
      metric: method,
      methods: methodsEvidence(comparisons, p),
      reference_mode: split.mode,
      reference: { n: matched.nRef, from: windowStart, to: referenceEnd },
      recent: { n: matched.nCur, from: Math.min(...recentSamples.map((s) => s.start)), to: windowEnd },
      bins: binsEvidence(matched, split.bins),
      bin_widths: { c_rate: p.cRateBinWidth, temp_c: p.tempBinWidthC },
      reference_rules: { per_bin: p.referencePerBin, max_spread_days: p.maxReferenceSpreadDays, lead_bin: split.leadBin },
      rest_pair_rules: { rest_minutes: p.restMinutes, min_delta_soc_pct: p.minDeltaSocRest, soc_sigma_pct: p.socSigmaPct },
      cautions: method === 'capacity_ah_anchored' ? [] : [SOC_RECALIBRATION_CAUTION],
      trend: trend.json,
      charge_time: { reference_current_a: r(refA, 1), baseline_hours: refA ? r(baselineAh / refA, 3) : null, current_hours: refA ? r(currentAh / refA, 3) : null },
      overlay: { reference: curveFor(input.curves, input.sessions, referenceSamples), recent: curveFor(input.curves, input.sessions, recentSamples) },
      checks,
      baseline_start: Number.isFinite(from) ? from : null,
      as_of: dateKo(ctx.now),
    },
    inputHash: hashInput({
      detector: `${META.id}@${META.version}`,
      params: p,
      metric: method,
      reference: referenceSamples.map((s) => [s.start, s.value, s.weight, s.bin]),
      recent: recentSamples.map((s) => [s.start, s.value, s.weight, s.bin]),
    }),
  };
}



function detect(input: EssCapacityInput, ctx: DetectorContext<EssCapacityParams>): DetectorResult {
  const p = withDefaults(ESS_CAPACITY_DEFAULTS, ctx.params);
  if (!(input.ratedCapacityAh > 0)) return insufficient('랙 정격 용량이 없습니다');
  const comparisons: Comparison[] = [];
  for (const method of CAPACITY_METHOD_ORDER.filter((m) => enabled(m, p))) {
    const comparison = compare(method, input, ctx, p);
    comparisons.push(comparison); // 이 함수 안에서 방식별 결과를 모은다
    if (comparison.matched.status === 'ok') {
      const finding = buildFinding(input, ctx, p, comparison as OkComparison, comparisons);
      return { status: 'ok', findings: finding ? [finding] : [] };
    }
  }
  const detail = comparisons.map((c) => `${CAPACITY_METHOD_LABELS[c.method]} 기준 ${c.split.reference.length}·최근 ${c.split.recent.length}`).join(', ');
  return insufficient(`같은 조건 용량 표본 부족 (${detail}; bin당 ${p.minPerBin}개·최근 합계 ${p.minTotal}개 필요)`);
}

export const essCapacityFade: Detector<EssCapacityInput, EssCapacityParams> = {
  ...META,
  requires: {
    assetClass: ['ess.rack'],
    metrics: [
      required('batt.current', FAST_S), // 충전 Ah 적분·CC 구간 판정. CV 전이에서 전류가 수 분 만에 꺾인다
      required('batt.voltage', FAST_S), // CV 전이·충전 종료 앵커 판정
      required('batt.soc', FAST_S), // 휴지 끝 SOC 앵커와 SOC 변화 방식의 분모 (SOC 점프를 놓치면 용량이 틀린다)
      required('cell.voltage.max', FAST_S), // 셀 상한 도달 = 앵커 종료 조건. 종료 직전 몇 분에 결정된다
      required('cell.voltage.min', FAST_S), // 방전 하한 도달 (휴지 앵커 쌍의 방전 쪽 경계)
      required('cell.temp.avg', SLOW_S), // 조건 bin(5 °C 폭)에만 쓴다. 셀 온도는 열용량이 커 5분 안에 bin을 넘지 않는다
    ],
    minHistoryDays: 30,
  },
  defaultParams: ESS_CAPACITY_DEFAULTS,
  paramSchema: ESS_CAPACITY_PARAM_SCHEMA,
  detect,
};
