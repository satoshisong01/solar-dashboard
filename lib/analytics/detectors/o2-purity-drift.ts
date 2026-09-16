// o2.purity_drift@1 — 애노드 원가스 HTO(산소 중 수소) 상승. category safety · severity 4부터 시작한다.
// 왜 안전 계열인가: 고압가스안전관리 기준상 산소 중 수소가 4 vol%(폭발하한)에 이르면 안 되고,
//   현장 운용 한계선은 그 절반인 2 vol%로 두어 이 값을 넘으면 압축을 금지한다. 즉 '성능 저하'가 아니라 '운전 금지선'이다.
//   근거: docs/renewal/research/pid/research-oxygen.{json,md} (법정 압축금지선 2 vol%, 1일 1회 품질검사 99.5% 이상).
// 판정: 전해조 운전 시간의 일 HTO 중앙값이 기준 구간 대비 riseP 이상 오르고, 최근 기간 여유(한계 − 최근 p95)가 marginPct 아래.
// 판별 체크: ① 부분부하 비중 증가(크로스오버는 부하가 낮을수록 커진다 — 최대 오탐원) ② 분석기 교정·영점 ③ 절대 한계 여유 ④ 상승 추세 일관성 ⑤ 표본 수.
// 압축 정지·운전 정지 판단은 현장 안전책임자와 PLC 인터록의 몫이다. 이 콘솔은 근거와 여유만 제시한다.
import * as z from 'zod';
import type { HtoDay } from '../episodes/gapyeong-samples';
import { downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median, quantile } from '../stats/robust';
import { mannKendall } from '../stats/trend';
import { kstDateString, MS_PER_DAY, type JsonObject } from '../types';
import { levelCheck, medianOrNull, SAFETY_DISCLAIMER } from './check-helpers';
import { fixed, insufficient, r, signed, withDefaults } from './common';
import { intParam, iterationsParam, numParam } from './param-schema';
import { recommended, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck, Severity } from './types';

export interface O2PurityDriftInput {
  readonly assetId: number;
  readonly days: readonly HtoDay[];
  /** 분석기 교정·영점 이벤트 시각 (asset_event). 없으면 해당 체크는 데이터없음 */
  readonly calibrationTs?: readonly number[];
}

export interface O2PurityDriftParams {
  /** 법정 압축금지선 [vol%] */
  readonly limitPct: number;
  /** 폭발하한 [vol%] (근거 표시용) */
  readonly lelPct: number;
  readonly risePctPoints: number;
  readonly severeRisePctPoints: number;
  /** 한계까지 남은 여유가 이 값 아래면 finding */
  readonly marginPctPoints: number;
  readonly recentDays: number;
  readonly referenceDays: number;
  readonly minRecentDays: number;
  readonly minReferenceDays: number;
  readonly minHoursPerDay: number;
  /** 부하율 중앙값이 기준보다 이만큼 떨어지면 부분부하 체크가 지지 */
  readonly loadDropFraction: number;
  readonly iterations: number;
}

export const O2_PURITY_DRIFT_DEFAULTS: O2PurityDriftParams = Object.freeze({
  limitPct: 2,
  lelPct: 4,
  risePctPoints: 0.3,
  severeRisePctPoints: 0.8,
  marginPctPoints: 1,
  recentDays: 7,
  referenceDays: 14,
  minRecentDays: 4,
  minReferenceDays: 7,
  minHoursPerDay: 2,
  loadDropFraction: 0.15,
  iterations: 1000,
});

const D = O2_PURITY_DRIFT_DEFAULTS;
export const O2_PURITY_DRIFT_PARAM_SCHEMA = z.object({
  limitPct: numParam(D.limitPct, { label: '압축금지 한계', unit: 'vol%', min: 0.1, max: 10, description: '산소 중 수소 농도의 운전 금지선입니다. 국내 관행은 폭발하한 4 vol%의 절반인 2 vol%입니다.' }),
  lelPct: numParam(D.lelPct, { label: '폭발하한', unit: 'vol%', min: 0.5, max: 20, description: '산소 중 수소의 폭발하한입니다 (근거 표시용, 판정에는 쓰지 않습니다).' }),
  risePctPoints: numParam(D.risePctPoints, { label: '상승 경고 기준', unit: 'vol%p', min: 0.01, max: 5, description: '기준 구간 대비 일 중앙값이 이만큼 오르면 finding입니다.' }),
  severeRisePctPoints: numParam(D.severeRisePctPoints, { label: '상승 주의 기준', unit: 'vol%p', min: 0.01, max: 10, description: '이만큼 오르면 심각도를 올립니다.' }),
  marginPctPoints: numParam(D.marginPctPoints, { label: '한계 여유 기준', unit: 'vol%p', min: 0.05, max: 10, description: '압축금지 한계까지 남은 여유(한계 − 최근 95퍼센타일)가 이 값보다 작으면 finding입니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 2, max: 60, description: '최근 HTO를 보는 일수입니다.' }),
  referenceDays: intParam(D.referenceDays, { label: '기준 기간', unit: '일', min: 3, max: 180, description: '기준 창이 없을 때 첫 유효일부터 이 일수를 기준으로 씁니다.' }),
  minRecentDays: intParam(D.minRecentDays, { label: '최근 최소 유효일', unit: '일', min: 2, max: 60, description: '최근 기간 유효일이 이보다 적으면 판정 불능입니다.' }),
  minReferenceDays: intParam(D.minReferenceDays, { label: '기준 최소 유효일', unit: '일', min: 2, max: 120, description: '기준 유효일이 이보다 적으면 판정 불능입니다.' }),
  minHoursPerDay: intParam(D.minHoursPerDay, { label: '하루 최소 운전시간', unit: '시간', min: 1, max: 24, description: '전해조 운전시간이 이보다 짧은 날은 표본에서 뺍니다 (기동 구간만 있는 날은 HTO가 원래 높습니다).' }),
  loadDropFraction: numParam(D.loadDropFraction, { label: '부하율 하락 기준', unit: '', min: 0.01, max: 1, description: '최근 부하율 중앙값이 기준보다 이만큼 낮으면 부분부하 체크를 지지로 봅니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'o2.purity_drift', version: '1', failureMode: 'o2.purity_drift', category: 'safety' } as const;

interface Split {
  readonly valid: readonly HtoDay[];
  readonly reference: readonly HtoDay[];
  readonly recent: readonly HtoDay[];
}

function splitDays(input: O2PurityDriftInput, ctx: DetectorContext<O2PurityDriftParams>, p: O2PurityDriftParams): Split {
  const from = ctx.baselineResetAt ?? -Infinity;
  const valid = input.days.filter((d) => d.day >= from && d.day + MS_PER_DAY <= ctx.now && d.hours >= p.minHoursPerDay).sort((a, b) => a.day - b.day);
  const window = ctx.referenceWindow;
  const reference = window ? valid.filter((d) => d.day >= window.start && d.day < window.end) : valid.filter((d) => d.day < (valid[0]?.day ?? 0) + p.referenceDays * MS_PER_DAY);
  const referenceEnd = (reference.at(-1)?.day ?? -Infinity) + MS_PER_DAY;
  const recent = valid.filter((d) => d.day >= ctx.now - p.recentDays * MS_PER_DAY && d.day >= referenceEnd);
  return { valid, reference, recent };
}

function checksOf(input: O2PurityDriftInput, split: Split, p: O2PurityDriftParams, margin: number): DiagnosticCheck[] {
  const refLoad = medianOrNull(split.reference.flatMap((d) => d.loadFraction ?? []));
  const curLoad = medianOrNull(split.recent.flatMap((d) => d.loadFraction ?? []));
  const loadDrop = refLoad === null || curLoad === null ? null : refLoad - curLoad;
  const partLoad = levelCheck('part_load', '부분부하 비중 증가 (크로스오버는 부하가 낮을수록 커진다)', loadDrop, [p.loadDropFraction, 0.03], { ref_load: r(refLoad, 3), recent_load: r(curLoad, 3), drop: r(loadDrop, 3) }, {
    supports: '최근 전해조가 더 낮은 부하로 돌았습니다. 멤브레인 손상이 아니라 부분부하 크로스오버일 수 있습니다 — 같은 부하 구간으로 다시 비교하세요.',
    refutes: '부하율은 기준과 비슷합니다. 부분부하로는 설명되지 않습니다.',
    unknown: '부하율이 조금 낮아졌습니다.',
    no_data: '스택 전류·정격이 없어 부하율을 계산할 수 없습니다.',
  });

  const recentCalibration = (input.calibrationTs ?? []).filter((ts) => ts >= (split.reference.at(-1)?.day ?? -Infinity));
  const calibration = levelCheck('analyzer_calibration', '분석기 교정·영점 변경', input.calibrationTs === undefined ? null : recentCalibration.length, [1, 0], { recent_calibrations: recentCalibration.length }, {
    supports: '기준 구간 뒤에 분석기 교정·영점 변경이 있었습니다. 계단 변화인지 확인하고 기준선을 다시 잡으세요.',
    refutes: '분석기 교정 이력이 없습니다. 계측 변경으로는 설명되지 않습니다.',
    unknown: '교정 이력을 판단할 수 없습니다.',
    no_data: '분석기 교정 이벤트 기록이 없습니다.',
  });

  const limit = levelCheck('legal_limit_margin', `압축금지 한계(${p.limitPct} vol%)까지 남은 여유`, margin <= 0 ? 2 : p.marginPctPoints / Math.max(margin, 1e-6), [1, 0.5], { limit_pct: p.limitPct, lel_pct: p.lelPct, margin_pct_points: r(margin, 3) }, {
    supports: `최근 95퍼센타일이 압축금지 한계에 가깝거나 넘었습니다. 압축·출하 가능 여부는 현장 절차와 인터록으로 즉시 확인하세요. ${SAFETY_DISCLAIMER}`,
    refutes: '압축금지 한계까지 여유가 충분합니다.',
    unknown: '압축금지 한계까지 여유가 줄고 있습니다.',
    no_data: '한계 여유를 계산할 수 없습니다.',
  });

  const mk = split.valid.length >= 5 ? mannKendall(split.valid.map((d) => d.medianPct)) : null;
  const trend = levelCheck('trend_consistency', '상승 추세 일관성 (Mann–Kendall)', mk === null ? null : mk.tau > 0 ? 1 - mk.pValue : 0, [0.95, 0.5], { tau: r(mk?.tau ?? null, 3), p_value: r(mk?.pValue ?? null, 4) }, {
    supports: '전체 기간에 걸쳐 꾸준히 오르고 있습니다. 일시적 변동이 아닙니다.',
    refutes: '꾸준한 상승 추세는 없습니다. 최근 구간만의 변동일 수 있습니다.',
    unknown: '상승 추세가 약하게 있습니다.',
    no_data: '추세를 계산할 표본이 부족합니다 (5일 이상 필요).',
  });

  const thin = split.recent.length < p.minRecentDays + 1;
  const samples = levelCheck('sample_count', '표본 수', thin ? 0 : 1, [1, 0], { recent_days: split.recent.length, reference_days: split.reference.length }, {
    supports: '표본이 충분합니다.',
    refutes: '유효일이 적어 불확실성이 큽니다.',
    unknown: '유효일이 보통 수준입니다.',
    no_data: '유효일을 셀 수 없습니다.',
  });
  return [partLoad, calibration, limit, trend, samples];
}

function buildFinding(input: O2PurityDriftInput, ctx: DetectorContext<O2PurityDriftParams>, p: O2PurityDriftParams, split: Split): CandidateFinding | null {
  const referencePct = median(split.reference.map((d) => d.medianPct));
  const currentPct = median(split.recent.map((d) => d.medianPct));
  const rise = currentPct - referencePct;
  const recentP95 = quantile(split.recent.map((d) => d.maxPct), 0.95);
  const margin = p.limitPct - recentP95;
  if (!(rise > p.risePctPoints) && !(margin < p.marginPctPoints)) return null;
  // 안전 계열은 4에서 시작하고, 법정 압축금지선을 이미 넘었으면 5 (운전 금지선이라 성능 저하와 같은 등급에 둘 수 없다)
  const severity: Severity = margin <= 0 ? 5 : 4;
  const ci = bootstrapCI(split.recent.map((d) => d.medianPct), median, { iterations: p.iterations, rng: ctx.rng });
  const checks = checksOf(input, split, p, margin);
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const evidence: JsonObject = {
    method: 'daily_median_shift_with_legal_limit',
    limit: { compression_stop_pct: p.limitPct, lel_pct: p.lelPct, basis: '산소 중 수소 폭발하한 4 vol%의 절반을 운전 금지선으로 둔다 (research-oxygen)' },
    reference: { days: split.reference.length, median_pct: r(referencePct, 4) },
    recent: { days: split.recent.length, median_pct: r(currentPct, 4), p95_pct: r(recentP95, 4), margin_pct_points: r(margin, 4), ci_low: r(ci.ciLow, 4), ci_high: r(ci.ciHigh, 4) },
    days: downsample(split.valid.map((d) => ({ date: kstDateString(d.day), median_pct: r(d.medianPct, 4), max_pct: r(d.maxPct, 4), hours: d.hours, load: r(d.loadFraction, 3) })), 120),
    checks,
    note: `압축·출하 정지 판단은 현장 안전책임자와 PLC 인터록의 몫입니다. 국내법상 산소는 1일 1회 품질검사(순도 99.5% 이상)도 함께 기록해야 합니다. ${SAFETY_DISCLAIMER}`,
  };
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: split.recent.length, ciWidth: relativeCiWidth(currentPct, ci.ciLow, ci.ciHigh), dqCompleteness: 1, methodsAgree: checks.find((c) => c.id === 'part_load')?.status === 'refutes' }),
    title: `산소 중 수소(HTO) ${fixed(currentPct, 2)} vol% · 압축금지선까지 ${fixed(margin, 2)} vol%p`,
    summary:
      `전해조 운전 시간의 일 HTO 중앙값이 ${fixed(referencePct, 2)} → ${fixed(currentPct, 2)} vol%(${signed(rise, 2)} vol%p, 95% CI ${fixed(ci.ciLow, 2)} ~ ${fixed(ci.ciHigh, 2)})이고, ` +
      `최근 95퍼센타일 ${fixed(recentP95, 2)} vol%로 압축금지 한계 ${fixed(p.limitPct, 1)} vol%까지 여유가 ${fixed(margin, 2)} vol%p입니다.` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'h2_in_o2_pct', value: r(rise, 4) ?? 0, unit: 'vol%p', ciLow: null, ciHigh: null, baseline: r(referencePct, 4), current: r(currentPct, 4), levelUnit: 'vol%' },
    windowStart: split.reference[0]?.day ?? ctx.now,
    windowEnd: (split.recent.at(-1)?.day ?? ctx.now) + MS_PER_DAY,
    evidence,
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, reference: split.reference.map((d) => [d.day, r(d.medianPct, 4)]), recent: split.recent.map((d) => [d.day, r(d.medianPct, 4), r(d.maxPct, 4)]) }),
  };
}

function detect(input: O2PurityDriftInput, ctx: DetectorContext<O2PurityDriftParams>): DetectorResult {
  const p = withDefaults(O2_PURITY_DRIFT_DEFAULTS, ctx.params);
  const split = splitDays(input, ctx, p);
  if (split.reference.length < p.minReferenceDays || split.recent.length < p.minRecentDays) {
    return insufficient(`전해조 운전일 부족: 기준 ${split.reference.length}일·최근 ${split.recent.length}일 (각 ${p.minReferenceDays}·${p.minRecentDays}일 필요, 하루 ${p.minHoursPerDay}시간 이상 운전)`);
  }
  const finding = buildFinding(input, ctx, p, split);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const o2PurityDrift: Detector<O2PurityDriftInput, O2PurityDriftParams> = {
  ...META,
  requires: {
    assetClass: ['o2.plant'],
    metrics: [
      required('h2.in.o2', SLOW_S), // 애노드 원가스 HTO (한정자 o2.product). 판정의 본체
      required('h2.flow.mass', SLOW_S), // 전해조 운전 시간 판정 (정지 중 값은 공정 신호가 아니다)
      recommended('stack.current', SLOW_S), // 판별 체크 ① 부분부하 비중
      recommended('o2.purity', SLOW_S), // 법정 1일 1회 품질검사(99.5% 이상) 기록과 대조
    ],
    minHistoryDays: 21,
  },
  defaultParams: O2_PURITY_DRIFT_DEFAULTS,
  paramSchema: O2_PURITY_DRIFT_PARAM_SCHEMA,
  detect,
};
