// ess.resistance_growth@1 — 배터리 랙 직류 내부저항(전류 계단 R_step) 증가.
// ess.current_step 에피소드(|ΔI| ≥ minStepC, SOC 10~90%)의 R = ΔV/ΔI를 SOC bin × 셀온도 bin으로 나눠 기준 vs 최근 30일 matchedRatio + 경과일 추세.
// R_step은 샘플 주기 동안의 분극을 포함해 주기에 따라 값이 달라진다 → 가장 최근 주기(period_s)와 같은 계단만 비교하고 'R_{period_s}s'로 표기한다.
// 판별 체크: ① 저온 편중 ② 접속부 저항(셀 전압 편차는 그대로인데 랙 R만 증가 → 버스바·커넥터 체결) ③ 용량 감소 동반 ④ 샘플 주기 변경.
import * as z from 'zod';
import type { EssStepEpisode } from '../episodes/ess-steps';
import { binFloor } from '../episodes/series';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import { DAYS_PER_MONTH, MS_PER_DAY } from '../types';
import { levelCheck, makeCheck, medianShift } from './check-helpers';
import { fixed, insufficient, r, signed, withDefaults } from './common';
import { compareRise, riseEvidence, riseParamShape, riseWindow, trendAgrees, type RiseParams, type RiseResult, type RiseSample } from './matched-rise';
import { numParam } from './param-schema';
import { FAST_S, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck } from './types';

export interface EssResistanceInput {
  readonly assetId: number;
  readonly steps: readonly EssStepEpisode[];
  /** 같은 랙 ess.capacity_fade 최근 결과 (finding 효과 %·CI 상한). 없으면 용량 체크는 데이터없음 */
  readonly capacityFade?: { readonly effectPct: number; readonly ciHighPct: number | null } | null;
}

export interface EssResistanceParams extends RiseParams {
  readonly minStepC: number;
  readonly socMinPct: number;
  readonly socMaxPct: number;
  readonly socBinWidth: number;
  readonly tempBinWidthC: number;
  readonly coldShiftC: number;
  readonly cellDvRiseMv: number;
  readonly capacityFadePct: number;
}

export const ESS_RESISTANCE_DEFAULTS: EssResistanceParams = Object.freeze({
  referencePerBin: 10,
  maxReferenceSpreadDays: 120,
  recentDays: 30,
  minPerBin: 5,
  minTotal: 15,
  iterations: 1000,
  sev2Pct: 20,
  sev3Pct: 40,
  sev4Pct: 60,
  minStepC: 0.1,
  socMinPct: 10,
  socMaxPct: 90,
  socBinWidth: 10,
  tempBinWidthC: 5,
  coldShiftC: 3,
  cellDvRiseMv: 10,
  capacityFadePct: 3,
});

const D = ESS_RESISTANCE_DEFAULTS;
export const ESS_RESISTANCE_PARAM_SCHEMA = z.object({
  ...riseParamShape(D, '내부저항'),
  minStepC: numParam(D.minStepC, { label: '최소 전류 계단', unit: 'C', min: 0.02, max: 2, description: '한 샘플 간격 안 전류 변화가 정격 용량 대비 이 값 이상인 계단만 씁니다.' }),
  socMinPct: numParam(D.socMinPct, { label: 'SOC 하한', unit: '%', min: 0, max: 100, description: '이 SOC 미만의 계단은 뺍니다 (SOC 극단 구간은 저항이 달라집니다).' }),
  socMaxPct: numParam(D.socMaxPct, { label: 'SOC 상한', unit: '%', min: 0, max: 100, description: '이 SOC 이상의 계단은 뺍니다.' }),
  socBinWidth: numParam(D.socBinWidth, { label: 'SOC bin 폭', unit: '%', min: 1, max: 50, description: '같은 조건 비교에 쓰는 SOC 구간 폭입니다.' }),
  tempBinWidthC: numParam(D.tempBinWidthC, { label: '셀 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '같은 조건 비교에 쓰는 셀 온도 구간 폭입니다.' }),
  coldShiftC: numParam(D.coldShiftC, { label: '저온 편중 기준', unit: '°C', min: 0.5, max: 30, description: '최근 계단 셀 온도 중앙값이 기준보다 이만큼 낮으면 저온 체크를 지지로 봅니다.' }),
  cellDvRiseMv: numParam(D.cellDvRiseMv, { label: '셀 전압 편차 증가 기준', unit: 'mV', min: 1, max: 200, description: '계단 시점 셀 전압 편차가 이만큼 커지면 셀 쪽 원인으로 보고 접속부 체크를 반박합니다.' }),
  capacityFadePct: numParam(D.capacityFadePct, { label: '용량 감소 동반 기준', unit: '%', min: 0.5, max: 50, description: 'ess.capacity_fade 효과가 이 값 이상 감소(CI 상한 < 0)이면 용량 감소 동반을 지지로 봅니다.' }),
});

const META = { id: 'ess.resistance_growth', version: '1', failureMode: 'ess.resistance_growth', category: 'degradation' } as const;

interface Eligible {
  readonly steps: readonly EssStepEpisode[];
  readonly periodS: number | null;
  readonly periods: readonly number[];
}

function eligibleSteps(input: EssResistanceInput, ctx: DetectorContext<EssResistanceParams>, p: EssResistanceParams): Eligible {
  const from = ctx.baselineResetAt ?? -Infinity;
  const steps = input.steps
    .filter((e) => {
      const f = e.features;
      return e.valid && Math.abs(f.delta_i_c) >= p.minStepC && f.soc !== null && f.soc >= p.socMinPct && f.soc < p.socMaxPct && f.t_cell_c !== null && e.start >= from && e.end <= ctx.now;
    })
    .sort((a, b) => a.start - b.start);
  const periods = [...new Set(steps.map((e) => e.features.period_s))].sort((a, b) => a - b);
  const periodS = steps.at(-1)?.features.period_s ?? null;
  return { steps, periodS, periods };
}

function samplesOf(steps: readonly EssStepEpisode[], periodS: number, p: EssResistanceParams): RiseSample[] {
  const first = steps[0]?.start ?? 0;
  return steps
    .filter((e) => e.features.period_s === periodS)
    .map((e) => ({ start: e.start, end: e.end, value: e.features.r_mohm, weight: 1, bin: `${binFloor(e.features.soc ?? 0, p.socBinWidth)}|${binFloor(e.features.t_cell_c ?? 0, p.tempBinWidthC)}`, completeness: e.dq.completeness, axis: (e.start - first) / MS_PER_DAY }));
}

function checksOf(input: EssResistanceInput, result: RiseResult, byStart: ReadonlyMap<number, EssStepEpisode>, eligible: Eligible, p: EssResistanceParams): DiagnosticCheck[] {
  const values = (items: readonly RiseSample[], pick: (e: EssStepEpisode) => number | null) => items.flatMap((s) => {
    const e = byStart.get(s.start);
    return e === undefined ? [] : (pick(e) ?? []);
  });
  const temp = medianShift(values(result.reference, (e) => e.features.t_cell_c), values(result.recent, (e) => e.features.t_cell_c));
  const cold = levelCheck('cold', '저온 편중', temp === null ? null : -temp.shift, [p.coldShiftC, 1], { ref_c: r(temp?.ref ?? null, 2), recent_c: r(temp?.cur ?? null, 2) }, {
    supports: '최근 계단이 더 낮은 셀 온도에 몰려 있습니다. 같은 온도 bin으로 비교했지만 저온(15 °C 미만) 저항 증가가 남을 수 있습니다.',
    refutes: '최근 셀 온도가 기준보다 낮지 않습니다.',
    unknown: '최근 셀 온도가 조금 낮습니다.',
    no_data: '셀 온도 데이터가 없습니다.',
  });
  const dv = medianShift(values(result.reference, (e) => e.features.cell_dv_mv), values(result.recent, (e) => e.features.cell_dv_mv));
  const dvStatus = dv === null ? 'no_data' : dv.shift <= 3 ? 'supports' : dv.shift >= p.cellDvRiseMv ? 'refutes' : 'unknown';
  const connection = makeCheck('connection_resistance', '접속부 저항 (셀 편차는 그대로, 랙 R만 증가)', dvStatus, { ref_dv_mv: r(dv?.ref ?? null, 2), recent_dv_mv: r(dv?.cur ?? null, 2), rise_mv: r(dv?.shift ?? null, 2) }, {
    supports: '셀 전압 편차는 그대로인데 랙 저항만 올랐습니다. 버스바·커넥터·케이블 러그 체결 토크와 발열을 점검하세요.',
    refutes: '셀 전압 편차도 커졌습니다. 접속부보다 셀·모듈 열화 쪽을 먼저 보세요.',
    unknown: '셀 전압 편차가 조금 커졌습니다.',
    no_data: '계단 시점 셀 최고·최저 전압 데이터가 없습니다.',
  }[dvStatus]);
  const fade = input.capacityFade ?? null;
  const fadeStatus = fade === null ? 'no_data' : fade.effectPct <= -p.capacityFadePct && fade.ciHighPct !== null && fade.ciHighPct < 0 ? 'supports' : fade.effectPct > -1 ? 'refutes' : 'unknown';
  const capacity = makeCheck('capacity_fade', '용량 감소 동반', fadeStatus, { capacity_effect_pct: r(fade?.effectPct ?? null, 2), capacity_ci_high_pct: r(fade?.ciHighPct ?? null, 2) }, {
    supports: '같은 랙 유효용량도 줄었습니다. 셀 열화가 진행 중일 가능성이 큽니다.',
    refutes: '유효용량 감소는 뚜렷하지 않습니다.',
    unknown: '유효용량이 조금 줄었습니다.',
    no_data: '같은 랙 용량 감소 판정 결과가 없습니다.',
  }[fadeStatus]);
  const excluded = eligible.steps.filter((e) => e.features.period_s !== eligible.periodS).length;
  const periodChanged = eligible.periods.length > 1;
  const period = makeCheck('sample_period', '샘플 주기 변경', periodChanged ? 'supports' : 'refutes', { periods_s: [...eligible.periods], used_period_s: eligible.periodS, excluded_steps: excluded },
    periodChanged ? `전류·전압 샘플 주기가 바뀌었습니다(${eligible.periods.join('·')} s). R_step 정의가 달라지므로 최근 주기(${eligible.periodS} s) 계단만 비교했습니다.` : '분석 기간 동안 샘플 주기는 그대로입니다.');
  return [cold, connection, capacity, period];
}

function buildFinding(input: EssResistanceInput, ctx: DetectorContext<EssResistanceParams>, p: EssResistanceParams, eligible: Eligible, result: RiseResult): CandidateFinding | null {
  if (result.severity === null || eligible.periodS === null) return null;
  const byStart = new Map(eligible.steps.map((e) => [e.start, e]));
  const checks = checksOf(input, result, byStart, eligible, p);
  const metric = `R_${eligible.periodS}s`;
  const supported = checks.filter((c) => c.status === 'supports' && c.id !== 'sample_period').map((c) => c.label);
  const trendText = result.trend === null ? '' : ` 추세 ${signed(result.trend.slope, 2)}%/월.`;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity: result.severity,
    confidence: scoreConfidence({ n: result.matched.nCur, ciWidth: relativeCiWidth(result.risePct, result.ciLowPct, result.ciHighPct), dqCompleteness: median(result.recent.map((s) => s.completeness)), methodsAgree: trendAgrees(result.trend) }),
    title: `랙 직류 내부저항(${metric}) ${fixed(result.risePct, 1)}% 증가`,
    summary:
      `같은 SOC·셀온도 조건 전류 계단 ${result.matched.nCur}회 비교(샘플 주기 ${eligible.periodS} s): ${metric} ${fixed(result.baselineLevel, 1)} mΩ → ${fixed(result.currentLevel, 1)} mΩ(${signed(result.risePct, 1)}%, 95% CI ${signed(result.ciLowPct, 1)} ~ ${signed(result.ciHighPct, 1)}%).${trendText}` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric, value: r(result.risePct, 3) ?? 0, unit: '%', ciLow: r(result.ciLowPct, 3), ciHigh: r(result.ciHighPct, 3), baseline: r(result.baselineLevel, 3), current: r(result.currentLevel, 3), levelUnit: 'mΩ' },
    ...riseWindow(result),
    evidence: { ...riseEvidence(result, 3), metric, period_s: eligible.periodS, soc_range_pct: [p.socMinPct, p.socMaxPct], min_step_c: p.minStepC, bin_widths: { soc_pct: p.socBinWidth, temp_c: p.tempBinWidthC }, checks },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, now: ctx.now, reference: result.reference.map((s) => [s.start, s.value, s.bin]), recent: result.recent.map((s) => [s.start, s.value, s.bin]), capacity: input.capacityFade ?? null }),
  };
}

function detect(input: EssResistanceInput, ctx: DetectorContext<EssResistanceParams>): DetectorResult {
  const p = withDefaults(ESS_RESISTANCE_DEFAULTS, ctx.params);
  const eligible = eligibleSteps(input, ctx, p);
  if (eligible.periodS === null) return insufficient(`조건에 맞는 전류 계단이 없습니다 (|ΔI| ≥ ${fixed(p.minStepC, 2)}C, SOC ${fixed(p.socMinPct, 0)}~${fixed(p.socMaxPct, 0)}%, 셀 온도 필요)`);
  const outcome = compareRise(samplesOf(eligible.steps, eligible.periodS, p), ctx, p, { key: 'day', scale: DAYS_PER_MONTH, unit: '%/월' });
  if (!outcome.ok) return insufficient(`전류 계단 저항 ${outcome.reason}`);
  const finding = buildFinding(input, ctx, p, eligible, outcome.result);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const essResistanceGrowth: Detector<EssResistanceInput, EssResistanceParams> = {
  ...META,
  requires: {
    assetClass: ['ess.rack'],
    metrics: [
      required('batt.current', FAST_S), // R_step = ΔV/ΔI 계단. 주기가 길수록 계단 사이 분극이 섞인다 (DCIR 권장은 2초 이하)
      required('batt.voltage', FAST_S), // 같은 계단의 전압 차. 전류와 같은 주기여야 한다
      required('batt.soc', SLOW_S), // SOC bin(socBinWidth 기본 10%p) 배정에만 쓴다
      required('cell.temp.avg', SLOW_S), // 온도 bin(5 °C 폭) 배정에만 쓴다
    ],
    minHistoryDays: 45,
  },
  defaultParams: ESS_RESISTANCE_DEFAULTS,
  paramSchema: ESS_RESISTANCE_PARAM_SCHEMA,
  detect,
};
