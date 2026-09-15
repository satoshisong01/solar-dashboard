// el.sec_rise@1 — 전해조 시스템 비에너지(계통측 kWh / 생산 kg) 상승.
// el.steady_run 에피소드의 SEC를 전류밀도 bin × 스택온도 bin으로 나눠 기준(bin별 가장 이른 표본) vs 최근 30일 matchedRatio + 누적 운전시간 추세.
// 판별 체크: ① 스택 셀 전압 상승 동반(→ 스택 열화, category degradation) ② 정류기 효율 저하 ③ 패러데이 효율 저하
//           ④ 부분부하 운전 비중 증가(BoP 고정부하) ⑤ 퍼지 횟수 증가.
// 입력 rectifierEfficiency·purgeCounts(일 단위)는 load 계층이 m_1h·kpi_daily에서 만든다. 없으면 해당 체크는 데이터없음.
import * as z from 'zod';
import type { ElSteadyEpisode } from '../episodes/stack-episodes';
import { binFloor } from '../episodes/series';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import { MS_PER_DAY } from '../types';
import { levelCheck, medianChangePct, medianOrNull, medianShift } from './check-helpers';
import { H2_KG_PER_AMP_HOUR_PER_CELL } from './hydrogen-eos';
import { fixed, insufficient, r, signed, withDefaults, type TimedNumber } from './common';
import { binWeightedShift, compareRise, riseEvidence, riseParamShape, riseWindow, trendAgrees, type RiseParams, type RiseResult, type RiseSample } from './matched-rise';
import { completenessParam, numParam } from './param-schema';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck } from './types';


export interface ElSecRiseInput {
  /** finding을 붙일 설비 (스택 또는 전해조 설비) */
  readonly assetId: number;
  readonly nameplate: { readonly cellCount: number; readonly activeAreaCm2: number; readonly ratedCurrentA: number };
  readonly episodes: readonly ElSteadyEpisode[];
  /** 정류기 효율 일 중앙값 [%] (h2.elz.rectifier rectifier.efficiency) */
  readonly rectifierEfficiency?: readonly TimedNumber[];
  /** 일별 퍼지 횟수 증가분 [회] (purge.count delta) */
  readonly purgeCounts?: readonly TimedNumber[];
}

export interface ElSecRiseParams extends RiseParams {
  readonly breakInHours: number;
  readonly jBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minH2Kg: number;
  readonly minCompleteness: number;
  readonly cellVoltageShare: number;
  readonly rectifierDropPctPt: number;
  readonly faradayDropPctPt: number;
  readonly partialLoadFraction: number;
  readonly partialShareRise: number;
  readonly purgeRisePct: number;
}

export const EL_SEC_RISE_DEFAULTS: ElSecRiseParams = Object.freeze({
  referencePerBin: 10,
  maxReferenceSpreadDays: 120,
  recentDays: 30,
  minPerBin: 5,
  minTotal: 15,
  iterations: 1000,
  sev2Pct: 3,
  sev3Pct: 5,
  sev4Pct: 10,
  breakInHours: 1000,
  jBinWidth: 0.1,
  tempBinWidthC: 5,
  minH2Kg: 0.5,
  minCompleteness: 0.9,
  cellVoltageShare: 0.5,
  rectifierDropPctPt: 1,
  faradayDropPctPt: 1,
  partialLoadFraction: 0.4,
  partialShareRise: 0.2,
  purgeRisePct: 30,
});

const D = EL_SEC_RISE_DEFAULTS;
export const EL_SEC_RISE_PARAM_SCHEMA = z.object({
  ...riseParamShape(D, '비에너지'),
  breakInHours: numParam(D.breakInHours, { label: 'break-in 제외 운전시간', unit: 'h', min: 0, max: 20_000, description: '누적 운전시간이 이보다 작은 초기 구간은 비교에서 뺍니다.' }),
  jBinWidth: numParam(D.jBinWidth, { label: '전류밀도 bin 폭', unit: 'A/cm²', min: 0.01, max: 1, description: '같은 조건 비교에 쓰는 전류밀도 구간 폭입니다.' }),
  tempBinWidthC: numParam(D.tempBinWidthC, { label: '스택 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '같은 조건 비교에 쓰는 스택 온도 구간 폭입니다.' }),
  minH2Kg: numParam(D.minH2Kg, { label: '구간 최소 생산량', unit: 'kg', min: 0, max: 100, description: '생산량이 이보다 적은 정상운전 구간은 비에너지 잡음이 커서 뺍니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  cellVoltageShare: numParam(D.cellVoltageShare, { label: '스택 전압 설명 비율', unit: '', min: 0.05, max: 1, description: '같은 조건 셀 전압 상승률이 비에너지 상승률의 이 비율 이상이면 스택 열화 동반을 지지로 봅니다.' }),
  rectifierDropPctPt: numParam(D.rectifierDropPctPt, { label: '정류기 효율 저하 기준', unit: '%p', min: 0.1, max: 20, description: '정류기 효율 중앙값이 이만큼 떨어지면 정류기 체크를 지지로 봅니다.' }),
  faradayDropPctPt: numParam(D.faradayDropPctPt, { label: '패러데이 효율 저하 기준', unit: '%p', min: 0.1, max: 20, description: '측정 생산량 ÷ 전류 이론 생산량이 이만큼 떨어지면 패러데이 효율 체크를 지지로 봅니다.' }),
  partialLoadFraction: numParam(D.partialLoadFraction, { label: '부분부하 기준', unit: '', min: 0.05, max: 0.9, description: '전류밀도가 정격의 이 비율 미만인 구간을 부분부하로 셉니다.' }),
  partialShareRise: numParam(D.partialShareRise, { label: '부분부하 비중 증가 기준', unit: '', min: 0.01, max: 1, description: '부분부하 구간 비중이 이만큼 늘면 BoP 고정부하 영향 체크를 지지로 봅니다.' }),
  purgeRisePct: numParam(D.purgeRisePct, { label: '퍼지 횟수 증가 기준', unit: '%', min: 1, max: 1000, description: '일 퍼지 횟수 중앙값이 이 비율 이상 늘면 퍼지 체크를 지지로 봅니다.' }),
});

const META = { id: 'el.sec_rise', version: '1', failureMode: 'el.system_efficiency_loss', category: 'performance' } as const;

function samplesOf(input: ElSecRiseInput, ctx: DetectorContext<ElSecRiseParams>, p: ElSecRiseParams): RiseSample[] {
  const from = ctx.baselineResetAt ?? -Infinity;
  return input.episodes.flatMap((e) => {
    const f = e.features;
    const ok = e.valid && f.sec_kwh_per_kg !== null && f.sec_kwh_per_kg > 0 && (f.h2_kg ?? 0) >= p.minH2Kg && e.dq.completeness >= p.minCompleteness;
    if (!ok || f.op_hours_cum === null || f.op_hours_cum < p.breakInHours || e.start < from || e.end > ctx.now) return [];
    const tKey = f.t_stack_mean === null ? 'na' : String(binFloor(f.t_stack_mean, p.tempBinWidthC));
    return [{ start: e.start, end: e.end, value: f.sec_kwh_per_kg as number, weight: 1, bin: `${binFloor(f.j_mean, p.jBinWidth)}|${tKey}`, completeness: e.dq.completeness, axis: f.op_hours_cum }];
  });
}

const faradayPct = (e: ElSteadyEpisode, cells: number): number | null => {
  const theoretical = e.features.i_mean * cells * (e.features.duration_s / 3_600) * H2_KG_PER_AMP_HOUR_PER_CELL;
  return e.features.h2_kg === null || !(theoretical > 0) ? null : (e.features.h2_kg / theoretical) * 100;
};

interface CheckInput {
  readonly input: ElSecRiseInput;
  readonly p: ElSecRiseParams;
  readonly result: RiseResult;
  readonly ref: readonly ElSteadyEpisode[];
  readonly cur: readonly ElSteadyEpisode[];
  readonly byStart: ReadonlyMap<number, ElSteadyEpisode>;
}

function voltageCheck({ p, result, byStart }: CheckInput): DiagnosticCheck {
  const shift = binWeightedShift(result, (s) => byStart.get(s.start)?.features.v_cell_mean ?? null);
  const vMv = shift === null ? null : shift.shift * 1000;
  const share = shift === null || shift.pct === null || !(result.risePct > 0) ? null : shift.pct / result.risePct;
  return levelCheck('stack_voltage', '스택 셀 전압 상승 동반 (스택 열화)', share, [p.cellVoltageShare, 0.2], { v_cell_rise_pct: r(shift?.pct ?? null, 3), v_cell_rise_mv: r(vMv, 2), share_of_sec_rise: r(share, 3) }, {
    supports: `같은 조건 셀 전압이 ${fixed(vMv ?? 0, 1)} mV 올라 비에너지 상승의 상당 부분을 설명합니다. 스택 열화(el.voltage_rise)와 함께 확인하세요.`,
    refutes: '셀 전압은 거의 그대로입니다. 스택 밖(정류기·BoP·계량) 원인을 먼저 보세요.',
    unknown: '셀 전압이 조금 올랐지만 비에너지 상승을 다 설명하지는 못합니다.',
    no_data: '같은 조건 구간의 셀 전압 데이터가 없습니다.',
  });
}

interface Spans {
  readonly refFrom: number;
  readonly refTo: number;
  readonly curFrom: number;
}

const inSpan = (series: readonly TimedNumber[] | undefined, from: number, to: number): number[] => (series ?? []).filter((pt) => pt.ts >= from && pt.ts <= to).map((pt) => pt.value);

function checksOf(c: CheckInput, spans: Spans): DiagnosticCheck[] {
  const { input, p, ref, cur } = c;
  const rectifier = medianShift(inSpan(input.rectifierEfficiency, spans.refFrom, spans.refTo), inSpan(input.rectifierEfficiency, spans.curFrom, Infinity));
  const rectifierCheck = levelCheck('rectifier_efficiency', '정류기 효율 저하', rectifier === null ? null : -rectifier.shift, [p.rectifierDropPctPt, 0.3], { ref_pct: r(rectifier?.ref ?? null, 2), recent_pct: r(rectifier?.cur ?? null, 2) }, {
    supports: '정류기 효율이 떨어졌습니다. 정류소자·필터 커패시터·냉각을 점검하세요.',
    refutes: '정류기 효율은 그대로입니다.',
    unknown: '정류기 효율이 조금 떨어졌습니다.',
    no_data: '기준·최근 기간 정류기 효율 데이터가 없습니다.',
  });
  const faraday = medianShift(ref.flatMap((e) => faradayPct(e, input.nameplate.cellCount) ?? []), cur.flatMap((e) => faradayPct(e, input.nameplate.cellCount) ?? []));
  const faradayCheck = levelCheck('faraday_efficiency', '패러데이 효율 저하 (측정 H₂ ÷ 전류 이론값)', faraday === null ? null : -faraday.shift, [p.faradayDropPctPt, 0.3], { ref_pct: r(faraday?.ref ?? null, 2), recent_pct: r(faraday?.cur ?? null, 2) }, {
    supports: '같은 전류에서 측정 생산량이 줄었습니다. 크로스오버 증가·퍼지 손실·유량계 드리프트를 구분하세요.',
    refutes: '패러데이 효율은 그대로입니다.',
    unknown: '패러데이 효율이 조금 떨어졌습니다.',
    no_data: '전류·생산량 데이터가 부족합니다.',
  });
  const jRated = input.nameplate.ratedCurrentA / input.nameplate.activeAreaCm2;
  const share = (list: readonly ElSteadyEpisode[]) => list.filter((e) => e.features.j_mean < p.partialLoadFraction * jRated).length / Math.max(1, list.length);
  const partial = levelCheck('partial_load_share', '부분부하 운전 비중 증가 (BoP 고정부하)', share(cur) - share(ref), [p.partialShareRise, 0.05], { ref_share: r(share(ref), 3), recent_share: r(share(cur), 3) }, {
    supports: '부분부하 운전이 늘었습니다. 같은 조건 bin으로 비교했지만 BoP 고정부하 비중이 커져 비에너지가 오를 수 있습니다.',
    refutes: '부분부하 운전 비중은 그대로입니다.',
    unknown: '부분부하 운전 비중이 조금 늘었습니다.',
    no_data: '부분부하 비중을 계산할 구간이 없습니다.',
  });
  const purgeRef = inSpan(input.purgeCounts, spans.refFrom, spans.refTo);
  const purgeCur = inSpan(input.purgeCounts, spans.curFrom, Infinity);
  const purgeChange = medianChangePct(purgeRef, purgeCur);
  const purge = levelCheck('purge_count', '퍼지 횟수 증가', purgeChange, [p.purgeRisePct, 5], { ref_per_day: r(medianOrNull(purgeRef), 2), recent_per_day: r(medianOrNull(purgeCur), 2), change_pct: r(purgeChange, 1) }, {
    supports: '퍼지 횟수가 늘었습니다. 퍼지 손실이 비에너지를 올렸을 수 있습니다.',
    refutes: '퍼지 횟수는 늘지 않았습니다.',
    unknown: '퍼지 횟수 변화가 작습니다.',
    no_data: '기준·최근 기간 퍼지 횟수 데이터가 없습니다.',
  });
  return [voltageCheck(c), rectifierCheck, faradayCheck, partial, purge];
}

function buildFinding(input: ElSecRiseInput, ctx: DetectorContext<ElSecRiseParams>, p: ElSecRiseParams, result: RiseResult): CandidateFinding | null {
  if (result.severity === null) return null;
  const byStart = new Map(input.episodes.map((e) => [e.start, e]));
  const pick = (samples: readonly RiseSample[]) => samples.flatMap((s) => byStart.get(s.start) ?? []);
  const ref = pick(result.reference);
  const cur = pick(result.recent);
  const { windowStart, windowEnd } = riseWindow(result);
  const spans = { refFrom: windowStart, refTo: Math.max(...result.reference.map((s) => s.end)), curFrom: ctx.now - p.recentDays * MS_PER_DAY };
  const checks = checksOf({ input, p, result, ref, cur, byStart }, spans);
  const stackSupported = checks[0]?.status === 'supports';
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const trendText = result.trend === null ? '' : ` 누적 운전시간 추세 ${signed(result.trend.slope, 2)}%/1000 h.`;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: stackSupported ? 'degradation' : META.category,
    severity: result.severity,
    confidence: scoreConfidence({ n: result.matched.nCur, ciWidth: relativeCiWidth(result.risePct, result.ciLowPct, result.ciHighPct), dqCompleteness: median(result.recent.map((s) => s.completeness)), methodsAgree: trendAgrees(result.trend) }),
    title: `전해조 시스템 비에너지 ${fixed(result.risePct, 1)}% 상승`,
    summary:
      `같은 전류밀도·스택온도 조건 정상운전 ${result.matched.nCur}구간 비교: 계통측 비에너지 ${fixed(result.baselineLevel, 2)} kWh/kg → ${fixed(result.currentLevel, 2)} kWh/kg(${signed(result.risePct, 1)}%, 95% CI ${signed(result.ciLowPct, 1)} ~ ${signed(result.ciHighPct, 1)}%).${trendText}` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'sec_kwh_per_kg', value: r(result.risePct, 3) ?? 0, unit: '%', ciLow: r(result.ciLowPct, 3), ciHigh: r(result.ciHighPct, 3), baseline: r(result.baselineLevel, 3), current: r(result.currentLevel, 3), levelUnit: 'kWh/kg' },
    windowStart,
    windowEnd,
    evidence: { ...riseEvidence(result, 3), metric: 'sec_kwh_per_kg', bin_widths: { j_acm2: p.jBinWidth, temp_c: p.tempBinWidthC }, break_in_hours: p.breakInHours, checks },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, reference: result.reference.map((s) => [s.start, s.value, s.bin]), recent: result.recent.map((s) => [s.start, s.value, s.bin]), rectifier: input.rectifierEfficiency ?? null, purge: input.purgeCounts ?? null }),
  };
}

function detect(input: ElSecRiseInput, ctx: DetectorContext<ElSecRiseParams>): DetectorResult {
  const p = withDefaults(EL_SEC_RISE_DEFAULTS, ctx.params);
  const { cellCount, activeAreaCm2, ratedCurrentA } = input.nameplate;
  if (!(cellCount > 0 && activeAreaCm2 > 0 && ratedCurrentA > 0)) return insufficient('스택 명판(셀 수·활성면적·정격 전류)이 없습니다');
  const samples = samplesOf(input, ctx, p);
  if (samples.length === 0) return insufficient(`비에너지를 계산할 정상운전 구간이 없습니다 (break-in ${fixed(p.breakInHours, 0)} h 이후·생산량 ${fixed(p.minH2Kg, 1)} kg 이상 필요)`);
  const outcome = compareRise(samples, ctx, p, { key: 'op_h', scale: 1000, unit: '%/1000 h' });
  if (!outcome.ok) return insufficient(`비에너지 ${outcome.reason}`);
  const finding = buildFinding(input, ctx, p, outcome.result);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const elSecRise: Detector<ElSecRiseInput, ElSecRiseParams> = {
  ...META,
  requires: { assetClass: ['h2.elz.stack'], metrics: ['stack.current', 'stack.voltage', 'stack.temp', 'run.hours', 'h2.flow.mass', 'ac.power'], minPeriodS: 60, minHistoryDays: 45 },
  defaultParams: EL_SEC_RISE_DEFAULTS,
  paramSchema: EL_SEC_RISE_PARAM_SCHEMA,
  detect,
};
