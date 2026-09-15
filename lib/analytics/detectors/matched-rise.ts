// 같은 조건 비교 엔진 — "지표가 기준 대비 몇 % 올랐나" (el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth 공용, 순수).
// 1) 기준·최근 나누기: detector_config.reference_window가 있으면 그 창, 없으면 bin별 기준(bin마다 가장 이른 referencePerBin개,
//    bin 기준 시점 간격 규칙 포함) — ess.capacity_fade와 같은 규칙(ess-capacity-reference.ts)을 그대로 쓴다.
// 2) matchedRatio: bin별 (가중) 중앙값 비율을 최근 표본 가중치로 결합 + bin 내부 부트스트랩 95% CI.
// 3) 추세: 표본을 자기 bin 기준 중앙값 대비 %로 바꿔 추세 축(누적 운전시간·경과일) Theil–Sen + Mann–Kendall + CUSUM.
// 4) severity: 상승률이 sev2/3/4 이상이고 CI 하한 > 0일 때만.
import * as z from 'zod';
import { downsample } from '../episodes/series';
import { matchedRatio, type MatchedRatioOk } from '../stats/matched';
import { median } from '../stats/robust';
import { trendValueAt } from '../stats/trend';
import type { JsonObject, RandomSource, TimeWindow } from '../types';
import { groupedMedians, r, severityByMagnitude, summarizeTrend } from './common';
import { splitReferenceRecent, type ReferenceSplit } from './ess-capacity-reference';
import type { CapacitySample } from './ess-capacity-samples';
import { intParam, iterationsParam, numParam } from './param-schema';
import type { Severity } from './types';

/** 비교 표본: 시작·끝·값·가중치·조건 bin·완결성 + 추세 축 값 (없으면 null → 추세에서 뺀다) */
export interface RiseSample extends CapacitySample {
  readonly axis: number | null;
}

export interface RiseParams {
  readonly referencePerBin: number;
  readonly maxReferenceSpreadDays: number;
  readonly recentDays: number;
  readonly minPerBin: number;
  readonly minTotal: number;
  readonly iterations: number;
  readonly sev2Pct: number;
  readonly sev3Pct: number;
  readonly sev4Pct: number;
}

export interface RiseAxis {
  /** 근거 키 (예: op_h, day) */
  readonly key: string;
  /** 기울기 표시 배수 (%/h → %/1000 h면 1000) */
  readonly scale: number;
  /** 기울기 표시 단위 (예: %/1000 h) */
  readonly unit: string;
}

export interface RiseTrend {
  readonly slope: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly mkPValue: number;
  readonly alarm: boolean;
  readonly json: JsonObject;
}

export interface RiseResult {
  readonly split: ReferenceSplit<RiseSample>;
  readonly matched: MatchedRatioOk;
  readonly risePct: number;
  readonly ciLowPct: number;
  readonly ciHighPct: number;
  /** 상승률이 기준 미만이거나 CI 하한 ≤ 0이면 null */
  readonly severity: Severity | null;
  /** 결합에 쓴 bin의 기준·최근 표본 */
  readonly reference: readonly RiseSample[];
  readonly recent: readonly RiseSample[];
  /** Σ 결합 가중치 × bin 기준 중앙값, 현재 = 기준 × 비율 */
  readonly baselineLevel: number;
  readonly currentLevel: number;
  readonly trend: RiseTrend | null;
}

export type RiseOutcome = { readonly ok: true; readonly result: RiseResult } | { readonly ok: false; readonly reason: string };

export interface RiseContext {
  readonly now: number;
  readonly rng: RandomSource;
  readonly referenceWindow?: TimeWindow;
}

function trendOf(samples: readonly RiseSample[], binMedians: ReadonlyMap<string, number>, axis: RiseAxis): RiseTrend | null {
  const rows = samples.flatMap((s) => {
    const ref = binMedians.get(s.bin);
    return s.axis === null || ref === undefined || ref === 0 ? [] : [{ x: s.axis, y: (s.value / ref - 1) * 100 }];
  }).sort((a, b) => a.x - b.x);
  const grouped = groupedMedians(rows.map((row) => row.x), rows.map((row) => row.y), 120);
  const summary = summarizeTrend(grouped.xs, grouped.ys, { referenceCount: Math.max(3, Math.ceil(grouped.xs.length / 4)), sigmaFloor: 0.5, direction: 'up', k: 0.5, h: 5 });
  if (!summary) return null;
  const { fit } = summary;
  const first = grouped.xs[0] ?? 0;
  const last = grouped.xs[grouped.xs.length - 1] ?? 0;
  return {
    slope: fit.slope * axis.scale,
    ciLow: fit.ciLow * axis.scale,
    ciHigh: fit.ciHigh * axis.scale,
    mkPValue: summary.mkPValue,
    alarm: summary.alarmIndex !== null,
    json: {
      axis: axis.key,
      unit: axis.unit,
      slope: r(fit.slope * axis.scale, 4),
      ci_low: r(fit.ciLow * axis.scale, 4),
      ci_high: r(fit.ciHigh * axis.scale, 4),
      mann_kendall_p: r(summary.mkPValue, 4),
      change_start: summary.changeStartIndex === null ? null : r(grouped.xs[summary.changeStartIndex] ?? null, 2),
      points: downsample(grouped.xs.map((x, i) => ({ x: r(x, 2), pct: r(grouped.ys[i] ?? 0, 3) })), 120),
      line: [first, last].map((x) => ({ x: r(x, 2), pct: r(trendValueAt(fit, x), 3) })),
    },
  };
}

/** samples: 유효·완결성 통과·기준선 재설정 이후·분석 시각 이전 표본 (정렬은 여기서 한다) */
export function compareRise(samples: readonly RiseSample[], ctx: RiseContext, p: RiseParams, axis: RiseAxis): RiseOutcome {
  const sorted = [...samples].sort((a, b) => a.start - b.start);
  const split = splitReferenceRecent(sorted, { now: ctx.now, recentDays: p.recentDays, referencePerBin: p.referencePerBin, maxReferenceSpreadDays: p.maxReferenceSpreadDays, referenceWindow: ctx.referenceWindow });
  const matched = matchedRatio(split.reference, split.recent, (s) => s.bin, (s) => s.value, {
    minPerBin: p.minPerBin,
    minTotal: p.minTotal,
    minTotalReference: split.mode === 'per_bin' ? Math.min(p.referencePerBin, p.minTotal) : p.minTotal,
    iterations: p.iterations,
    rng: ctx.rng,
    weightKey: (s) => s.weight,
  });
  if (matched.status !== 'ok') return { ok: false, reason: matched.reason };
  const usedKeys = new Set(matched.bins.filter((b) => b.used).map((b) => b.key));
  const binMedians = new Map(matched.bins.flatMap((b) => (b.used && b.medRef !== null ? [[b.key, b.medRef] as const] : [])));
  const risePct = (matched.ratio - 1) * 100;
  const ciLowPct = (matched.ciLow - 1) * 100;
  const ciHighPct = (matched.ciHigh - 1) * 100;
  const magnitude = severityByMagnitude(risePct, [[p.sev4Pct, 4], [p.sev3Pct, 3], [p.sev2Pct, 2]]);
  const baselineLevel = matched.bins.reduce((sum, b) => sum + b.weight * (b.medRef ?? 0), 0);
  const recent = split.recent.filter((s) => usedKeys.has(s.bin));
  const reference = split.reference.filter((s) => usedKeys.has(s.bin));
  const trendSamples = sorted.filter((s) => usedKeys.has(s.bin));
  return {
    ok: true,
    result: {
      split,
      matched,
      risePct,
      ciLowPct,
      ciHighPct,
      severity: magnitude !== null && ciLowPct > 0 ? magnitude : null,
      reference,
      recent,
      baselineLevel,
      currentLevel: baselineLevel * matched.ratio,
      trend: trendOf(trendSamples, binMedians, axis),
    },
  };
}

/** bin 표 (값 자릿수 지정) */
export function riseBinsEvidence(result: RiseResult, decimals: number): JsonObject[] {
  return result.matched.bins.map((b) => {
    const ref = result.split.bins.find((item) => item.key === b.key);
    return {
      key: b.key,
      n_ref: b.nRef,
      n_cur: b.nCur,
      med_ref: r(b.medRef, decimals),
      med_cur: r(b.medCur, decimals),
      ratio: r(b.ratio, 4),
      used: b.used,
      weight: r(b.weight, 4),
      ref_from: ref?.refFrom ?? null,
      ref_to: ref?.refTo ?? null,
      excluded: ref?.excluded ?? null,
    };
  });
}

/** 근거 공통 조각: 비교 방식·기준/최근 기간·bin 표·추세 */
export function riseEvidence(result: RiseResult, decimals: number): JsonObject {
  const span = (items: readonly RiseSample[]) => (items.length === 0 ? null : { n: items.length, from: Math.min(...items.map((s) => s.start)), to: Math.max(...items.map((s) => s.end)) });
  return {
    method: 'matched_ratio',
    reference_mode: result.split.mode,
    lead_bin: result.split.leadBin,
    reference: span(result.reference),
    recent: span(result.recent),
    rise_pct: r(result.risePct, 3),
    ci_low_pct: r(result.ciLowPct, 3),
    ci_high_pct: r(result.ciHighPct, 3),
    bins: riseBinsEvidence(result, decimals),
    trend: result.trend?.json ?? null,
  };
}

/** 창 경계: 기준 첫 표본 시작 ~ 최근 마지막 표본 끝 */
export const riseWindow = (result: RiseResult): { windowStart: number; windowEnd: number } => ({
  windowStart: Math.min(...result.reference.map((s) => s.start)),
  windowEnd: Math.max(...result.recent.map((s) => s.end)),
});

export interface BinShift {
  /** 결합 가중치로 평균한 bin별 (최근 중앙값 − 기준 중앙값) */
  readonly shift: number;
  /** 같은 방식의 변화율 [%] (기준 중앙값이 0 이하인 bin이 있으면 null) */
  readonly pct: number | null;
  readonly ref: number;
  readonly cur: number;
}

/** 결합에 쓴 bin마다 다른 특징(토출 온도·셀 전압 등)의 기준·최근 중앙값을 비교해 결합 가중치로 평균한다. 특징이 있는 bin이 없으면 null */
export function binWeightedShift(result: RiseResult, featureOf: (s: RiseSample) => number | null): BinShift | null {
  const values = (items: readonly RiseSample[], key: string) => items.flatMap((s) => (s.bin === key ? (featureOf(s) ?? []) : []));
  const parts = result.matched.bins.flatMap((b) => {
    const ref = values(result.reference, b.key);
    const cur = values(result.recent, b.key);
    if (!b.used || ref.length === 0 || cur.length === 0) return [];
    const medRef = median(ref);
    const medCur = median(cur);
    return [{ weight: b.weight, ref: medRef, cur: medCur, pct: medRef > 0 ? (medCur / medRef - 1) * 100 : null }];
  });
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  if (parts.length === 0 || !(total > 0)) return null;
  const avg = (fn: (part: (typeof parts)[number]) => number) => parts.reduce((sum, part) => sum + part.weight * fn(part), 0) / total;
  return { shift: avg((part) => part.cur - part.ref), pct: parts.some((part) => part.pct === null) ? null : avg((part) => part.pct ?? 0), ref: avg((part) => part.ref), cur: avg((part) => part.cur) };
}

/** 추세가 상승과 같은 결론인지 (CI 하한 > 0, CUSUM 경보, Mann–Kendall p < 0.05 중 하나) */
export const trendAgrees = (trend: RiseTrend | null): boolean | null => (trend === null ? null : trend.ciLow > 0 || trend.alarm || (trend.mkPValue < 0.05 && trend.slope > 0));

/** RiseParams zod 필드 (탐지기 스키마에 펼쳐 넣는다) */
export function riseParamShape(d: RiseParams, subject: string) {
  return {
    referencePerBin: intParam(d.referencePerBin, { label: 'bin별 기준 표본 수', unit: '개', min: 2, max: 200, description: `조건 bin마다 가장 이른 이 수만큼의 ${subject} 표본을 그 bin의 기준으로 씁니다 (기준 창이 없을 때).` }),
    maxReferenceSpreadDays: numParam(d.maxReferenceSpreadDays, { label: 'bin 기준 시점 간격 상한', unit: '일', min: 1, max: 1000, description: 'bin 기준 시점이 주 bin 기준 시점에서 이만큼 넘게 떨어지면 그 bin을 결합에서 뺍니다.' }),
    recentDays: intParam(d.recentDays, { label: '최근 기간', unit: '일', min: 7, max: 180, description: `최근 ${subject} 표본을 모으는 기간입니다.` }),
    minPerBin: intParam(d.minPerBin, { label: 'bin당 최소 표본', unit: '개', min: 1, max: 200, description: '기준·최근 모두 이 수 이상인 bin만 비교에 씁니다.' }),
    minTotal: intParam(d.minTotal, { label: '최근 표본 합계 하한', unit: '개', min: 3, max: 2000, description: '사용한 bin의 최근 표본 합계가 이보다 적으면 판정 불능입니다.' }),
    iterations: iterationsParam(d.iterations),
    sev2Pct: numParam(d.sev2Pct, { label: 'severity 2 상승률', unit: '%', min: 0.1, max: 500, description: `같은 조건 ${subject} 상승률이 이 값 이상이고 95% CI 하한이 0보다 크면 finding(severity 2)입니다.` }),
    sev3Pct: numParam(d.sev3Pct, { label: 'severity 3 상승률', unit: '%', min: 0.1, max: 500, description: '이 값 이상이면 severity 3입니다.' }),
    sev4Pct: numParam(d.sev4Pct, { label: 'severity 4 상승률', unit: '%', min: 0.1, max: 500, description: '이 값 이상이면 severity 4입니다.' }),
  } satisfies z.ZodRawShape;
}
