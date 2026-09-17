// hx.fouling@1 — 폐열회수 열교환기 성능 저하 (오염·스케일).
// 같은 1차측 입구 온도 bin에서 접근온도(1차측 입구 − 2차측 출구)가 벌어지면 열전달이 나빠진 것이다.
// 2차측 입구 온도와 유량이 함께 있으면 UA = Q/LMTD를 계산해 %로도 본다 (1차측 유량계가 없어도 접근온도로 판정할 수 있게 한 이유 — research-heat).
// 판별 체크: ① 1차측 차압 상승(스케일·막힘) ② 2차측 유량 저하 ③ ΔΘ 부족 구간(계측 오차 폭증) ④ 1차측 입구 온도 편중 ⑤ 표본 수.
//
// 근거: docs/renewal/research/pid/research-heat.{json,md}
//   - 접근온도 경고 +3 K / 주의 +5 K, UA 경고 −15% / 주의 −25%
//   - 양측 열수지 절대값 검사는 쓰지 않는다: 설계상 Q_cold가 Q_hot의 약 7%라 상시 오경보가 난다
//   - ΔΘ 10 K 미만 구간은 적산열량계 감온부 오차 Et = ±(0.5 + 3·ΔΘmin/ΔΘ)%가 폭증해 뺀다
import * as z from 'zod';
import type { HxSample } from '../episodes/gapyeong-samples';
import { binFloor, downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { resample } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median, quantileSorted, sortedCopy } from '../stats/robust';
import { kstDateString, MS_PER_DAY, type JsonObject, type RandomSource } from '../types';
import { levelCheck, medianShift, SAFETY_DISCLAIMER } from './check-helpers';
import { fixed, insufficient, r, severityByMagnitude, signed, withDefaults } from './common';
import { completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import { recommended, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck, Severity } from './types';

export interface HxFoulingInput {
  readonly assetId: number;
  /** 명판 설계 접근온도 [K] (없으면 기준 구간 값을 쓴다) */
  readonly designApproachK: number | null;
  readonly designUaKwK: number | null;
  readonly samples: readonly HxSample[];
}

export interface HxFoulingParams {
  readonly approachRiseK: number;
  readonly severeApproachRiseK: number;
  readonly uaDropPct: number;
  readonly severeUaDropPct: number;
  readonly recentDays: number;
  readonly referenceDays: number;
  readonly minPerWindow: number;
  readonly hotBinWidthC: number;
  /** 양측 온도차가 이보다 작은 시간은 계측 오차가 커서 뺀다 [K] */
  readonly minDeltaThetaK: number;
  readonly minCompleteness: number;
  readonly diffPressureRisePct: number;
  readonly coldFlowDropPct: number;
  readonly hotInShiftC: number;
  readonly iterations: number;
}

export const HX_FOULING_DEFAULTS: HxFoulingParams = Object.freeze({
  approachRiseK: 3,
  severeApproachRiseK: 5,
  uaDropPct: 15,
  severeUaDropPct: 25,
  recentDays: 7,
  referenceDays: 14,
  minPerWindow: 12,
  hotBinWidthC: 3,
  minDeltaThetaK: 10,
  minCompleteness: 0.8,
  diffPressureRisePct: 20,
  coldFlowDropPct: 10,
  hotInShiftC: 3,
  iterations: 1000,
});

const D = HX_FOULING_DEFAULTS;
export const HX_FOULING_PARAM_SCHEMA = z.object({
  approachRiseK: numParam(D.approachRiseK, { label: '접근온도 상승 경고', unit: 'K', min: 0.2, max: 50, description: '같은 1차측 입구 온도 bin에서 접근온도(1차 입구 − 2차 출구)가 이만큼 오르면 finding입니다.' }),
  severeApproachRiseK: numParam(D.severeApproachRiseK, { label: '접근온도 상승 주의', unit: 'K', min: 0.2, max: 80, description: '이만큼 오르면 심각도를 올립니다.' }),
  uaDropPct: numParam(D.uaDropPct, { label: 'UA 저하 경고', unit: '%', min: 1, max: 90, description: '2차측 입구 온도·유량이 있으면 UA 저하율도 함께 봅니다.' }),
  severeUaDropPct: numParam(D.severeUaDropPct, { label: 'UA 저하 주의', unit: '%', min: 1, max: 95, description: 'UA가 이만큼 떨어지면 심각도를 올립니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 2, max: 60, description: '최근 성능을 보는 기간입니다.' }),
  referenceDays: intParam(D.referenceDays, { label: '기준 기간', unit: '일', min: 3, max: 120, description: '기준 창이 없을 때 첫 유효일부터 이 일수를 기준으로 씁니다 (세정 직후 구간을 기준으로 잡는 것이 좋습니다).' }),
  minPerWindow: intParam(D.minPerWindow, { label: '창별 최소 표본', unit: '시간', min: 3, max: 500, description: '기준·최근 창에 이보다 적은 정상상태 시간이 있으면 판정 불능입니다.' }),
  hotBinWidthC: numParam(D.hotBinWidthC, { label: '1차측 입구 온도 bin 폭', unit: '°C', min: 0.5, max: 20, description: '같은 조건 비교에 쓰는 1차측 입구 온도 구간 폭입니다.' }),
  minDeltaThetaK: numParam(D.minDeltaThetaK, { label: '최소 양측 온도차', unit: 'K', min: 1, max: 50, description: '1차측 입구와 2차측 입구 온도차가 이보다 작은 시간은 계측 오차가 커서 뺍니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  diffPressureRisePct: numParam(D.diffPressureRisePct, { label: '1차측 차압 상승 기준', unit: '%', min: 1, max: 300, description: '1차측 차압 중앙값이 이 비율 이상 오르면 스케일·막힘 체크를 지지로 봅니다.' }),
  coldFlowDropPct: numParam(D.coldFlowDropPct, { label: '2차측 유량 저하 기준', unit: '%', min: 1, max: 90, description: '2차측 유량 중앙값이 이 비율 이상 줄면 유량 저하 체크를 지지로 봅니다 (오염이 아니라 유량 문제).' }),
  hotInShiftC: numParam(D.hotInShiftC, { label: '1차측 입구 온도 편중 기준', unit: '°C', min: 0.5, max: 30, description: '최근 1차측 입구 온도 중앙값이 기준과 이만큼 다르면 조건 편중 체크를 지지로 봅니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'hx.fouling', version: '1', failureMode: 'hx.heat_recovery_loss', category: 'performance' } as const;

/** 물 비열 [kJ/(kg·K)] */
const CP_WATER = 4.186;

interface Point {
  readonly hourStart: number;
  readonly approachK: number;
  readonly bin: number;
  readonly uaKwK: number | null;
  readonly hotInC: number;
  readonly coldFlowM3H: number | null;
  readonly diffHotKpa: number | null;
}

/** 대수평균 온도차 [K]. 양측 온도차가 같거나 부호가 다르면 null */
export function lmtd(hotInC: number, hotOutC: number, coldInC: number, coldOutC: number): number | null {
  const d1 = hotInC - coldOutC;
  const d2 = hotOutC - coldInC;
  if (!(d1 > 0) || !(d2 > 0)) return null;
  return Math.abs(d1 - d2) < 1e-6 ? d1 : (d1 - d2) / Math.log(d1 / d2);
}

function pointOf(s: HxSample, p: HxFoulingParams): Point | null {
  if (s.coldInC !== null && s.hotInC - s.coldInC < p.minDeltaThetaK) return null;
  const heatKw = s.heatKw ?? (s.coldInC !== null && s.coldFlowM3H !== null ? ((s.coldFlowM3H * 1000) / 3_600) * CP_WATER * (s.coldOutC - s.coldInC) : null);
  const mean = s.coldInC === null || s.hotOutC === null || heatKw === null ? null : lmtd(s.hotInC, s.hotOutC, s.coldInC, s.coldOutC);
  return {
    hourStart: s.hourStart,
    approachK: s.hotInC - s.coldOutC,
    bin: binFloor(s.hotInC, p.hotBinWidthC),
    uaKwK: mean !== null && mean > 0 && heatKw !== null && heatKw > 0 ? heatKw / mean : null,
    hotInC: s.hotInC,
    coldFlowM3H: s.coldFlowM3H,
    diffHotKpa: s.diffHotKpa,
  };
}

interface Split {
  readonly reference: readonly Point[];
  readonly recent: readonly Point[];
  /** 기준·최근 양쪽에 표본이 있는 1차측 입구 온도 bin */
  readonly bins: readonly number[];
}

function splitSamples(input: HxFoulingInput, ctx: DetectorContext<HxFoulingParams>, p: HxFoulingParams): Split {
  const from = ctx.baselineResetAt ?? -Infinity;
  const points = input.samples
    .filter((s) => s.hourStart >= from && s.hourStart < ctx.now)
    .map((s) => pointOf(s, p))
    .filter((x): x is Point => x !== null)
    .sort((a, b) => a.hourStart - b.hourStart);
  const window = ctx.referenceWindow;
  const reference = window ? points.filter((x) => x.hourStart >= window.start && x.hourStart < window.end) : points.filter((x) => x.hourStart < (points[0]?.hourStart ?? 0) + p.referenceDays * MS_PER_DAY);
  const referenceEnd = (reference.at(-1)?.hourStart ?? -Infinity) + 1;
  const recent = points.filter((x) => x.hourStart >= ctx.now - p.recentDays * MS_PER_DAY && x.hourStart >= referenceEnd);
  const refBins = new Set(reference.map((x) => x.bin));
  const bins = [...new Set(recent.map((x) => x.bin))].filter((b) => refBins.has(b)).sort((a, b) => a - b);
  return { reference, recent, bins };
}

/** bin마다 (최근 중앙값 − 기준 중앙값)을 구해 표본 수로 가중 평균한다 */
function binShift(split: Split, pick: (x: Point) => number | null): { readonly shift: number; readonly ref: number; readonly cur: number; readonly n: number } | null {
  const rows = split.bins.flatMap((bin) => {
    const ref = split.reference.filter((x) => x.bin === bin).flatMap((x) => pick(x) ?? []);
    const cur = split.recent.filter((x) => x.bin === bin).flatMap((x) => pick(x) ?? []);
    return ref.length === 0 || cur.length === 0 ? [] : [{ ref: median(ref), cur: median(cur), n: cur.length }];
  });
  if (rows.length === 0) return null;
  const weight = rows.reduce((sum, row) => sum + row.n, 0);
  const wmean = (get: (row: (typeof rows)[number]) => number) => rows.reduce((sum, row) => sum + get(row) * row.n, 0) / weight;
  const ref = wmean((row) => row.ref);
  const cur = wmean((row) => row.cur);
  return { shift: cur - ref, ref, cur, n: weight };
}

/** bin별 값과 결합 가중치. 대표값은 bin별 중앙값을 최근 표본 수 비율로 가중 평균한 값이다 */
interface LevelBin {
  readonly values: readonly number[];
  readonly weight: number;
}

const levelOf = (bins: readonly LevelBin[]): number => bins.reduce((sum, bin) => sum + bin.weight * median(bin.values), 0);

/**
 * 최근 대표 접근온도의 95% CI. 대표값이 bin별 중앙값의 가중 평균이므로 CI도 같은 통계량으로 내야 한다 —
 * 전체 표본의 단순 중앙값을 부트스트랩하면 다른 값을 추정하게 되어 구간이 자기 대표값을 품지 않는다.
 * bin 안에서만 복원추출하고 결합 가중치는 고정한다 (stats/matched.ts의 matchedRatio와 같은 방식).
 */
function recentLevelCI(split: Split, iterations: number, rng: RandomSource): { readonly low: number; readonly high: number } | null {
  const rows = split.bins.flatMap((bin) => {
    const values = split.recent.filter((x) => x.bin === bin).map((x) => x.approachK);
    return values.length === 0 ? [] : [values];
  });
  const total = rows.reduce((sum, values) => sum + values.length, 0);
  if (total === 0) return null;
  const bins: LevelBin[] = rows.map((values) => ({ values, weight: values.length / total }));
  const stats = sortedCopy(Array.from({ length: iterations }, () => levelOf(bins.map((bin) => ({ ...bin, values: resample(bin.values, rng) })))));
  return { low: quantileSorted(stats, 0.025), high: quantileSorted(stats, 0.975) };
}

function checksOf(split: Split, p: HxFoulingParams): DiagnosticCheck[] {
  const diff = binShift(split, (x) => x.diffHotKpa);
  const diffPct = diff === null || !(diff.ref > 0) ? null : (diff.cur / diff.ref - 1) * 100;
  const pressure = levelCheck('pressure_drop', '1차측 차압 상승 (스케일·막힘)', diffPct, [p.diffPressureRisePct, 5], { ref_kpa: r(diff?.ref ?? null, 2), recent_kpa: r(diff?.cur ?? null, 2), change_pct: r(diffPct, 1) }, {
    supports: '같은 조건에서 1차측 차압이 올랐습니다. 표면 막이 아니라 스케일·막힘일 가능성이 큽니다 — 화학 세정을 검토하세요.',
    refutes: '1차측 차압은 그대로입니다. 스케일보다 표면 막·유량 문제에 가깝습니다.',
    unknown: '1차측 차압이 조금 올랐습니다.',
    no_data: '1차측 차압 데이터가 없습니다.',
  });

  const flow = binShift(split, (x) => x.coldFlowM3H);
  const flowDropPct = flow === null || !(flow.ref > 0) ? null : (1 - flow.cur / flow.ref) * 100;
  const coldFlow = levelCheck('cold_flow_drop', '2차측 유량 저하', flowDropPct, [p.coldFlowDropPct, 2], { ref_m3_h: r(flow?.ref ?? null, 3), recent_m3_h: r(flow?.cur ?? null, 3), drop_pct: r(flowDropPct, 1) }, {
    supports: '2차측 유량이 줄었습니다. 열교환기 오염이 아니라 펌프·필터 문제일 수 있습니다.',
    refutes: '2차측 유량은 그대로입니다.',
    unknown: '2차측 유량이 조금 줄었습니다.',
    no_data: '2차측 유량 데이터가 없습니다 (hx.flow.cold 확보 권고).',
  });

  const hotIn = medianShift(split.reference.map((x) => x.hotInC), split.recent.map((x) => x.hotInC));
  const condition = levelCheck('hot_inlet_shift', '1차측 입구 온도 편중', hotIn === null ? null : Math.abs(hotIn.shift), [p.hotInShiftC, 1], { ref_c: r(hotIn?.ref ?? null, 2), recent_c: r(hotIn?.cur ?? null, 2) }, {
    supports: '최근 운전이 다른 1차측 입구 온도대에 몰려 있습니다. 같은 bin으로 비교했지만 조건 차이가 남을 수 있습니다.',
    refutes: '1차측 입구 온도 분포가 비슷합니다.',
    unknown: '1차측 입구 온도가 조금 달라졌습니다.',
    no_data: '1차측 입구 온도를 비교할 수 없습니다.',
  });

  const uaPoints = split.recent.filter((x) => x.uaKwK !== null).length;
  const method = levelCheck('ua_available', 'UA 계산 가능 (2차측 입구 온도·유량)', uaPoints === 0 ? 0 : uaPoints / Math.max(split.recent.length, 1), [0.5, 0.1], { ua_points: uaPoints, recent_points: split.recent.length }, {
    supports: 'UA를 계산할 수 있어 접근온도와 함께 확인했습니다.',
    refutes: '2차측 입구 온도·유량이 없어 접근온도만으로 판정했습니다 (TT-304·유량계 신설 권고).',
    unknown: 'UA를 계산할 수 있는 시간이 일부뿐입니다.',
    no_data: 'UA 계산 입력이 없습니다.',
  });

  const thin = split.recent.length < p.minPerWindow * 2;
  const samples = levelCheck('sample_count', '표본 수', thin ? 0 : 1, [1, 0], { recent_points: split.recent.length, reference_points: split.reference.length, bins: split.bins.length }, {
    supports: '표본이 충분합니다.',
    refutes: '표본이 적어 불확실성이 큽니다. 다음 실행에서 다시 확인하세요.',
    unknown: '표본이 보통 수준입니다.',
    no_data: '표본 수를 셀 수 없습니다.',
  });
  return [pressure, coldFlow, condition, method, samples];
}

function buildFinding(input: HxFoulingInput, ctx: DetectorContext<HxFoulingParams>, p: HxFoulingParams, split: Split): CandidateFinding | null {
  const approach = binShift(split, (x) => x.approachK);
  if (approach === null || !(approach.shift > p.approachRiseK)) return null;
  const ua = binShift(split, (x) => x.uaKwK);
  const uaDropPct = ua === null || !(ua.ref > 0) ? null : (1 - ua.cur / ua.ref) * 100;
  const severity: Severity =
    severityByMagnitude(Math.max(approach.shift / p.approachRiseK, (uaDropPct ?? 0) / p.uaDropPct), [[Math.max(p.severeApproachRiseK / p.approachRiseK, p.severeUaDropPct / p.uaDropPct), 3], [1, 2]]) ?? 2;
  const ci = recentLevelCI(split, p.iterations, ctx.rng);
  const checks = checksOf(split, p);
  const supported = checks.filter((c) => c.status === 'supports' && c.id !== 'ua_available' && c.id !== 'sample_count').map((c) => c.label);
  const evidence: JsonObject = {
    method: 'approach_bin_shift',
    sign_convention: '접근온도 = 1차측 입구 − 2차측 출구 (양수 상승 = 열전달 저하). 양측 열수지 절대값 검사는 쓰지 않는다 (설계상 Q_cold ≈ Q_hot의 7%)',
    bin: { key: 'hx_temp_hot_in_c', width: p.hotBinWidthC, bins: split.bins },
    gate: { min_delta_theta_k: p.minDeltaThetaK },
    design: { approach_k: r(input.designApproachK, 2), ua_kw_k: r(input.designUaKwK, 4) },
    approach: { reference_k: r(approach.ref, 2), recent_k: r(approach.cur, 2), rise_k: r(approach.shift, 2), ci_low_k: r(ci?.low ?? null, 2), ci_high_k: r(ci?.high ?? null, 2) },
    ua: ua === null ? null : { reference_kw_k: r(ua.ref, 4), recent_kw_k: r(ua.cur, 4), drop_pct: r(uaDropPct, 2) },
    points: downsample(split.recent.map((x) => ({ date: kstDateString(x.hourStart), hot_in_c: r(x.hotInC, 2), approach_k: r(x.approachK, 2), ua_kw_k: r(x.uaKwK, 4) })), 120),
    checks,
    note: `열교환기 성능 판정입니다. 교차누설 의심(2차측 전도도 상승)은 수전해 스택 보호 문제라 별도 확인이 필요합니다. ${SAFETY_DISCLAIMER}`,
  };
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: split.recent.length, ciWidth: relativeCiWidth(approach.cur, ci?.low ?? null, ci?.high ?? null), dqCompleteness: 1, methodsAgree: uaDropPct !== null && uaDropPct > p.uaDropPct }),
    title: `폐열회수 열교환기 접근온도 ${signed(approach.shift, 1)} K`,
    summary:
      `같은 1차측 입구 온도 조건(bin ${split.bins.length}개, 최근 ${split.recent.length}시간)에서 접근온도가 ${fixed(approach.ref, 1)} K → ${fixed(approach.cur, 1)} K(${signed(approach.shift, 1)} K, 기준 ${fixed(p.approachRiseK, 1)} K)로 벌어졌습니다.` +
      (uaDropPct === null ? ' 2차측 입구 온도·유량이 없어 UA는 계산하지 못했습니다.' : ` UA ${fixed(ua?.ref ?? 0, 3)} → ${fixed(ua?.cur ?? 0, 3)} kW/K(${signed(-uaDropPct, 1)}%).`) +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'hx_approach_k', value: r(approach.shift, 3) ?? 0, unit: 'K', ciLow: null, ciHigh: null, baseline: r(approach.ref, 3), current: r(approach.cur, 3), levelUnit: 'K' },
    windowStart: split.reference[0]?.hourStart ?? ctx.now,
    windowEnd: (split.recent.at(-1)?.hourStart ?? ctx.now) + 3_600_000,
    evidence,
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, reference: split.reference.map((x) => [x.hourStart, r(x.approachK, 3)]), recent: split.recent.map((x) => [x.hourStart, r(x.approachK, 3)]) }),
  };
}

function detect(input: HxFoulingInput, ctx: DetectorContext<HxFoulingParams>): DetectorResult {
  const p = withDefaults(HX_FOULING_DEFAULTS, ctx.params);
  const split = splitSamples(input, ctx, p);
  if (split.reference.length < p.minPerWindow || split.recent.length < p.minPerWindow) {
    return insufficient(`정상상태 표본 부족: 기준 ${split.reference.length}시간·최근 ${split.recent.length}시간 (각 ${p.minPerWindow}시간 필요, 양측 온도차 ${fixed(p.minDeltaThetaK, 0)} K 이상)`);
  }
  if (split.bins.length === 0) return insufficient('기준·최근에 공통으로 있는 1차측 입구 온도 구간이 없습니다');
  const finding = buildFinding(input, ctx, p, split);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const hxFouling: Detector<HxFoulingInput, HxFoulingParams> = {
  ...META,
  requires: {
    assetClass: ['hx.recovery'],
    metrics: [
      required('hx.temp.hot.in', SLOW_S), // 1차측 입구 (연료전지 냉각수 출구). 접근온도의 기준점
      required('hx.temp.cold.out', SLOW_S), // 2차측 출구 (수전해 급수). 접근온도의 다른 한 점
      recommended('hx.temp.cold.in', SLOW_S), // UA 계산 — 없으면 접근온도만으로 판정한다
      recommended('hx.temp.hot.out', SLOW_S), // LMTD 계산
      recommended('hx.flow.cold', SLOW_S), // 회수 열량 계산·유량 저하 판별
      recommended('hx.heat.recovered', SLOW_S), // 적산열량계가 있으면 유량·비열 대신 쓴다
      recommended('hx.pressure.diff.hot', SLOW_S), // 판별 체크 ① 스케일·막힘
    ],
    minHistoryDays: 21,
  },
  defaultParams: HX_FOULING_DEFAULTS,
  paramSchema: HX_FOULING_PARAM_SCHEMA,
  detect,
};
