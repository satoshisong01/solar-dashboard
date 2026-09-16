// fc.blower_wear@1 — 연료전지 공기 블로워 비전력(블로워 전력 ÷ 공기 유량) 증가.
// fc.blower_run 에피소드를 유량 bin × 외기온도 bin으로 나눠 기준 vs 최근 30일 matchedRatio + 스택 누적 운전시간 추세.
// bin 안 유량 차이는 친화 법칙(P ∝ Q³ → P/Q ∝ Q²)으로 bin 중심 유량에 맞춰 보정한다 (affinityExponent, 0이면 끔).
// 판별 체크: ① 에어필터 막힘(과거 필터 교체 뒤 회복 이력) ② 베어링·임펠러 마모(기준 이후 필터 교체에도 회복 없음)
//           ③ 외기 밀도(고온 편중) ④ 스택 전압 감쇠 동반(공기 부족 → 전압 영향).
// 필터 교체 = asset_event(kind maintenance·replacement, note에 '필터' 또는 'filter').
import * as z from 'zod';
import type { FcBlowerRunEpisode } from '../episodes/fc-blower';
import { binFloor } from '../episodes/series';
import type { FcSteadyEpisode } from '../episodes/stack-episodes';
import { hashInput } from '../hash';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { median } from '../stats/robust';
import { MS_PER_DAY, type JsonObject } from '../types';
import { levelCheck, makeCheck, medianOrNull, medianShift } from './check-helpers';
import { dateKo, fixed, insufficient, r, signed, withDefaults } from './common';
import { compareRise, riseEvidence, riseParamShape, riseWindow, trendAgrees, type RiseParams, type RiseResult, type RiseSample } from './matched-rise';
import { completenessParam, numParam } from './param-schema';
import { required, SLOW_S } from './requirements';
import type { AssetEventInput, CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck } from './types';

export interface FcBlowerWearInput {
  readonly assetId: number;
  readonly runs: readonly FcBlowerRunEpisode[];
  /** 블로워·상위 연료전지 설비 이벤트 (필터 교체 판별) */
  readonly events: readonly AssetEventInput[];
  /** 같은 연료전지 스택의 정상운전 에피소드 (스택 전압 감쇠 체크). 없으면 데이터없음 */
  readonly stackEpisodes?: readonly FcSteadyEpisode[];
}

export interface FcBlowerWearParams extends RiseParams {
  readonly flowBinWidthKgH: number;
  readonly tempBinWidthC: number;
  readonly affinityExponent: number;
  readonly minCompleteness: number;
  readonly filterWindowDays: number;
  readonly filterRecoveryPct: number;
  readonly ambientShiftC: number;
  readonly stackDecayMv: number;
}

export const FC_BLOWER_WEAR_DEFAULTS: FcBlowerWearParams = Object.freeze({
  referencePerBin: 10,
  maxReferenceSpreadDays: 120,
  recentDays: 30,
  minPerBin: 5,
  minTotal: 15,
  iterations: 1000,
  sev2Pct: 10,
  sev3Pct: 20,
  sev4Pct: 35,
  flowBinWidthKgH: 100,
  tempBinWidthC: 5,
  affinityExponent: 2,
  minCompleteness: 0.8,
  filterWindowDays: 14,
  filterRecoveryPct: 5,
  ambientShiftC: 5,
  stackDecayMv: 5,
});

const D = FC_BLOWER_WEAR_DEFAULTS;
export const FC_BLOWER_WEAR_PARAM_SCHEMA = z.object({
  ...riseParamShape(D, '블로워 비전력'),
  flowBinWidthKgH: numParam(D.flowBinWidthKgH, { label: '공기 유량 bin 폭', unit: 'kg/h', min: 1, max: 5000, description: '같은 조건 비교에 쓰는 공기 유량 구간 폭입니다.' }),
  tempBinWidthC: numParam(D.tempBinWidthC, { label: '외기 온도 bin 폭', unit: '°C', min: 1, max: 20, description: '공기 밀도 차이를 줄이려고 외기 온도로 나누는 구간 폭입니다.' }),
  affinityExponent: numParam(D.affinityExponent, { label: 'bin 안 유량 보정 지수', unit: '', min: 0, max: 3, description: '비전력 × (bin 중심 유량 ÷ 유량)^지수로 bin 안 유량 차이를 보정합니다. 친화 법칙 P ∝ Q³이면 2, 0이면 보정하지 않습니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  filterWindowDays: numParam(D.filterWindowDays, { label: '필터 교체 전후 비교 기간', unit: '일', min: 1, max: 90, description: '필터 교체 전·후 이 기간의 비전력을 비교해 회복 폭을 잽니다.' }),
  filterRecoveryPct: numParam(D.filterRecoveryPct, { label: '필터 교체 회복 기준', unit: '%', min: 0.5, max: 100, description: '필터 교체 뒤 비전력이 이 비율 이상 낮아지면 필터 영향이 컸다고 봅니다.' }),
  ambientShiftC: numParam(D.ambientShiftC, { label: '외기 온도 편중 기준', unit: '°C', min: 0.5, max: 30, description: '최근 운전 외기 온도 중앙값이 기준보다 이만큼 높으면 외기 밀도 체크를 지지로 봅니다.' }),
  stackDecayMv: numParam(D.stackDecayMv, { label: '스택 전압 감쇠 기준', unit: 'mV', min: 0.1, max: 100, description: '기준 전류밀도 셀 전압이 이만큼 떨어지면 스택 전압 영향 체크를 지지로 봅니다.' }),
});

const META = { id: 'fc.blower_wear', version: '1', failureMode: 'fc.blower_wear', category: 'degradation' } as const;
const FILTER_NOTE = /필터|filter/i;

function samplesOf(input: FcBlowerWearInput, ctx: DetectorContext<FcBlowerWearParams>, p: FcBlowerWearParams): RiseSample[] {
  const from = ctx.baselineResetAt ?? -Infinity;
  return input.runs.flatMap((e) => {
    const f = e.features;
    if (!e.valid || f.specific_w_per_kg_h === null || !(f.specific_w_per_kg_h > 0) || !(f.flow_kg_h > 0) || e.dq.completeness < p.minCompleteness || e.start < from || e.end > ctx.now) return [];
    const flowBin = binFloor(f.flow_kg_h, p.flowBinWidthKgH);
    const center = flowBin + p.flowBinWidthKgH / 2;
    const value = f.specific_w_per_kg_h * (center / f.flow_kg_h) ** p.affinityExponent;
    const tKey = f.ambient_c === null ? 'na' : String(binFloor(f.ambient_c, p.tempBinWidthC));
    return [{ start: e.start, end: e.end, value, weight: 1, bin: `${flowBin}|${tKey}`, completeness: e.dq.completeness, axis: f.op_hours_cum }];
  });
}

interface FilterRecovery {
  readonly ts: number;
  readonly recoveryPct: number | null;
}

/** 필터 교체마다 전·후 filterWindowDays 동안 bin 기준 대비 비율 중앙값 차이 [%p] */
function filterRecoveries(samples: readonly RiseSample[], result: RiseResult, events: readonly AssetEventInput[], p: FcBlowerWearParams, now: number): FilterRecovery[] {
  const refMedians = new Map(result.matched.bins.flatMap((b) => (b.used && b.medRef ? [[b.key, b.medRef] as const] : [])));
  const ratios = samples.flatMap((s) => {
    const ref = refMedians.get(s.bin);
    return ref === undefined ? [] : [{ ts: s.start, pct: (s.value / ref) * 100 }];
  });
  const windowMs = p.filterWindowDays * MS_PER_DAY;
  return events
    .filter((e) => (e.kind === 'maintenance' || e.kind === 'replacement') && FILTER_NOTE.test(e.note ?? '') && e.ts <= now)
    .map((e) => {
      const before = medianOrNull(ratios.filter((x) => x.ts >= e.ts - windowMs && x.ts < e.ts).map((x) => x.pct));
      const after = medianOrNull(ratios.filter((x) => x.ts >= e.ts && x.ts <= e.ts + windowMs).map((x) => x.pct));
      return { ts: e.ts, recoveryPct: before === null || after === null ? null : before - after };
    });
}

function filterChecks(recoveries: readonly FilterRecovery[], referenceEnd: number, p: FcBlowerWearParams): DiagnosticCheck[] {
  const measuredOf = (items: readonly FilterRecovery[]): JsonObject => ({ filter_events: items.map((x) => ({ date: dateKo(x.ts), recovery_pct: r(x.recoveryPct, 2) })) });
  // 기준 기간 이전 교체만 보면 준공 직후 교체가 없는 설비에서 늘 '데이터없음'이었다.
  // 창 안(상승 이후 포함) 교체도 같은 회복률 계산으로 함께 본다 — 상승 뒤 교체로 회복됐으면 그 자체가 필터 막힘 근거다.
  const measured = recoveries.filter((x) => x.recoveryPct !== null);
  const best = measured.length === 0 ? null : Math.max(...measured.map((x) => x.recoveryPct ?? 0));
  const clogging = measured.length === 0
    ? makeCheck('air_filter', '에어필터 막힘 (교체 후 회복 이력)', 'no_data', measuredOf(recoveries), '창 안에 전후 비교가 되는 필터 교체 기록이 없습니다. 흡입필터 차압을 확인하세요.')
    : levelCheck('air_filter', '에어필터 막힘 (교체 후 회복 이력)', best, [p.filterRecoveryPct, 1], measuredOf(measured), {
        supports: '필터 교체 뒤 비전력이 회복된 이력이 있습니다. 이번 상승도 필터 막힘일 수 있으니 필터부터 교체하고 다시 비교하세요.',
        refutes: '필터 교체 뒤에도 비전력이 회복되지 않았습니다. 필터보다 블로워 자체 원인을 의심하세요.',
        unknown: '필터 교체 뒤 회복 폭이 작습니다.',
        no_data: '필터 교체 전후 데이터가 부족합니다.',
      });
  const latest = recoveries.filter((x) => x.ts > referenceEnd).at(-1);
  const wear = latest === undefined || latest.recoveryPct === null
    ? makeCheck('bearing_impeller', '베어링·임펠러 마모 (필터 교체 후에도 회복 없음)', 'no_data', measuredOf(recoveries), '기준 기간 이후 필터 교체 기록(또는 전후 데이터)이 없어 구분할 수 없습니다. 필터 교체 후 다시 비교하세요.')
    : levelCheck('bearing_impeller', '베어링·임펠러 마모 (필터 교체 후에도 회복 없음)', -latest.recoveryPct, [-1, -p.filterRecoveryPct], measuredOf([latest]), {
        supports: '최근 필터를 교체했는데도 비전력이 회복되지 않았습니다. 베어링 소음·진동과 임펠러 상태를 점검하세요.',
        refutes: '최근 필터 교체 뒤 비전력이 일부 회복됐습니다. 남은 상승분은 교체 주기와 함께 보세요.',
        unknown: '최근 필터 교체 뒤 회복 폭이 작습니다.',
        no_data: '필터 교체 전후 데이터가 부족합니다.',
      });
  return [clogging, wear];
}

function contextChecks(input: FcBlowerWearInput, result: RiseResult, byStart: ReadonlyMap<number, FcBlowerRunEpisode>, spans: { refFrom: number; refTo: number; curFrom: number }, p: FcBlowerWearParams): DiagnosticCheck[] {
  const ambientOf = (items: readonly RiseSample[]) => items.flatMap((s) => byStart.get(s.start)?.features.ambient_c ?? []);
  const ambient = medianShift(ambientOf(result.reference), ambientOf(result.recent));
  const density = levelCheck('air_density', '외기 밀도 (고온 편중)', ambient?.shift ?? null, [p.ambientShiftC, 2], { ref_c: r(ambient?.ref ?? null, 2), recent_c: r(ambient?.cur ?? null, 2) }, {
    supports: '최근 운전이 더 더운 조건에 몰려 있습니다. 같은 외기 bin으로 비교했지만 공기 밀도 저하 영향이 남을 수 있습니다.',
    refutes: '외기 온도 분포는 비슷합니다.',
    unknown: '최근 외기 온도가 조금 높습니다.',
    no_data: '외기 온도 데이터가 없습니다.',
  });
  const vRef = (input.stackEpisodes ?? []).flatMap((e) => (e.valid && e.start >= spans.refFrom && e.start <= spans.refTo ? (e.features.v_cell_at_jref ?? []) : []));
  const vCur = (input.stackEpisodes ?? []).flatMap((e) => (e.valid && e.start >= spans.curFrom ? (e.features.v_cell_at_jref ?? []) : []));
  const v = medianShift(vRef, vCur);
  const stack = levelCheck('stack_voltage', '스택 전압 감쇠 동반 (공기 부족)', v === null ? null : -v.shift * 1000, [p.stackDecayMv, 1], { ref_mv: r(v === null ? null : v.ref * 1000, 2), recent_mv: r(v === null ? null : v.cur * 1000, 2) }, {
    supports: '같은 기간 기준 전류밀도 셀 전압도 떨어졌습니다. 공기 공급 부족이 스택 전압에 영향을 줄 수 있으니 블로워를 먼저 점검하세요.',
    refutes: '스택 전압은 그대로입니다.',
    unknown: '스택 전압이 조금 떨어졌습니다.',
    no_data: '같은 기간 스택 정상운전 전압 데이터가 없습니다.',
  });
  return [density, stack];
}

function buildFinding(input: FcBlowerWearInput, ctx: DetectorContext<FcBlowerWearParams>, p: FcBlowerWearParams, samples: readonly RiseSample[], result: RiseResult): CandidateFinding | null {
  if (result.severity === null) return null;
  const byStart = new Map(input.runs.map((e) => [e.start, e]));
  const { windowStart, windowEnd } = riseWindow(result);
  const spans = { refFrom: windowStart, refTo: Math.max(...result.reference.map((s) => s.end)), curFrom: ctx.now - p.recentDays * MS_PER_DAY };
  const checks = [...filterChecks(filterRecoveries(samples, result, input.events, p, ctx.now), spans.refTo, p), ...contextChecks(input, result, byStart, spans, p)];
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const trendText = result.trend === null ? '' : ` 스택 누적 운전시간 추세 ${signed(result.trend.slope, 2)}%/1000 h.`;
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity: result.severity,
    confidence: scoreConfidence({ n: result.matched.nCur, ciWidth: relativeCiWidth(result.risePct, result.ciLowPct, result.ciHighPct), dqCompleteness: median(result.recent.map((s) => s.completeness)), methodsAgree: trendAgrees(result.trend) }),
    title: `공기 블로워 비전력 ${fixed(result.risePct, 1)}% 증가`,
    summary:
      `같은 공기 유량·외기 온도 조건 정상운전 ${result.matched.nCur}구간 비교: 블로워 비전력 ${fixed(result.baselineLevel, 2)} → ${fixed(result.currentLevel, 2)} W/(kg/h)(${signed(result.risePct, 1)}%, 95% CI ${signed(result.ciLowPct, 1)} ~ ${signed(result.ciHighPct, 1)}%).${trendText}` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'blower_specific_power', value: r(result.risePct, 3) ?? 0, unit: '%', ciLow: r(result.ciLowPct, 3), ciHigh: r(result.ciHighPct, 3), baseline: r(result.baselineLevel, 4), current: r(result.currentLevel, 4), levelUnit: 'W/(kg/h)' },
    windowStart,
    windowEnd,
    evidence: { ...riseEvidence(result, 4), metric: 'blower_specific_power', bin_widths: { flow_kg_h: p.flowBinWidthKgH, ambient_c: p.tempBinWidthC }, affinity_exponent: p.affinityExponent, checks },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, reference: result.reference.map((s) => [s.start, s.value, s.bin]), recent: result.recent.map((s) => [s.start, s.value, s.bin]), events: input.events.map((e) => [e.ts, e.kind, e.note ?? null]) }),
  };
}

function detect(input: FcBlowerWearInput, ctx: DetectorContext<FcBlowerWearParams>): DetectorResult {
  const p = withDefaults(FC_BLOWER_WEAR_DEFAULTS, ctx.params);
  const samples = samplesOf(input, ctx, p);
  if (samples.length === 0) return insufficient('비전력을 계산할 블로워 정상운전 구간이 없습니다 (블로워 전력·공기 유량 필요)');
  const outcome = compareRise(samples, ctx, p, { key: 'op_h', scale: 1000, unit: '%/1000 h' });
  if (!outcome.ok) return insufficient(`블로워 비전력 ${outcome.reason}`);
  const finding = buildFinding(input, ctx, p, samples, outcome.result);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const fcBlowerWear: Detector<FcBlowerWearInput, FcBlowerWearParams> = {
  ...META,
  requires: {
    assetClass: ['fc.blower'],
    metrics: [
      required('blower.power', SLOW_S), // 비전력 분자. 블로워 전력은 공기 유량 설정값을 따라 분 단위로 계단 변화한다
      required('blower.flow', SLOW_S), // 비전력 분모 + 유량 bin
      required('ambient.temp', SLOW_S), // 흡입 공기 밀도 조건 bin (외기는 시간 단위로 변한다)
      required('run.hours', SLOW_S), // 형제 스택 누적 운전시간 축 (일 단위 증가량)
    ],
    minHistoryDays: 45,
  },
  defaultParams: FC_BLOWER_WEAR_DEFAULTS,
  paramSchema: FC_BLOWER_WEAR_PARAM_SCHEMA,
  detect,
};
