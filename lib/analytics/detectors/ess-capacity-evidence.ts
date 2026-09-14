// ess.capacity_fade 근거 조각 (순수): 정격 대비 추세·SOH 도달 추정, 대표 세션 오버레이 곡선, bin 표.
import type { EssChargeEpisode } from '../episodes/ess';
import type { ChargeCurvePoint } from '../episodes/ess-features';
import { downsample } from '../episodes/series';
import type { MatchedRatioOk } from '../stats/matched';
import { median } from '../stats/robust';
import { trendValueAt } from '../stats/trend';
import { DAYS_PER_MONTH, MS_PER_DAY, type JsonObject } from '../types';
import { dailyMedians, r, summarizeTrend } from './common';
import type { BinReference } from './ess-capacity-reference';
import type { CapacitySample } from './ess-capacity-samples';

export interface TrendRules {
  readonly ratedCapacityAh: number;
  readonly sohTargetPct: number;
  readonly cusumK: number;
  readonly cusumH: number;
  readonly sigmaFloorPct: number;
  /** 외삽(SOH 도달일)에 필요한 최소 데이터 기간 [일]. 화면·리포트가 같은 규칙으로 표시 여부를 정한다 */
  readonly minSpanDaysForProjection: number;
}

/** 전체 표본의 일 중앙값(정격 대비 %) 추세. referenceEnd 이전 일수를 CUSUM 기준 구간으로 쓴다 */
export function trendEvidence(samples: readonly CapacitySample[], referenceEnd: number, baselineAh: number, rules: TrendRules): { json: JsonObject | null; agrees: boolean | null } {
  const daily = dailyMedians(samples.map((s) => ({ ts: s.start, value: (s.value / rules.ratedCapacityAh) * 100 })));
  const t0 = daily[0]?.ts ?? 0;
  const xs = daily.map((d) => (d.ts - t0) / MS_PER_DAY);
  const ys = daily.map((d) => d.value);
  const referenceCount = daily.filter((d) => d.ts <= referenceEnd).length;
  const summary = summarizeTrend(xs, ys, { referenceCount, sigmaFloor: (rules.sigmaFloorPct / 100) * (baselineAh / rules.ratedCapacityAh) * 100, direction: 'down', k: rules.cusumK, h: rules.cusumH });
  if (!summary) return { json: null, agrees: null };
  const { fit } = summary;
  const reachDay = (slope: number) => (slope < 0 ? t0 + (median(xs) + (rules.sohTargetPct - median(ys)) / slope) * MS_PER_DAY : null);
  const changeTs = summary.changeStartIndex === null ? null : (daily[summary.changeStartIndex]?.ts ?? null);
  const json: JsonObject = {
    slope_pct_per_month: r(fit.slope * DAYS_PER_MONTH, 3),
    ci_low_pct_per_month: r(fit.ciLow * DAYS_PER_MONTH, 3),
    ci_high_pct_per_month: r(fit.ciHigh * DAYS_PER_MONTH, 3),
    mann_kendall_p: r(summary.mkPValue, 4),
    change_start: changeTs,
    span_days: r(xs[xs.length - 1] ?? 0, 1),
    min_span_days_for_projection: rules.minSpanDaysForProjection,
    soh_target_pct: rules.sohTargetPct,
    soh_target_date: { estimate: reachDay(fit.slope), early: reachDay(fit.ciLow), late: fit.ciHigh < 0 ? reachDay(fit.ciHigh) : null },
    points: downsample(daily, 120).map((d) => ({ t: d.ts, soh_pct: r(d.value, 3) })),
    line: [0, xs[xs.length - 1] ?? 0].map((x) => ({ t: t0 + x * MS_PER_DAY, soh_pct: r(trendValueAt(fit, x), 3) })),
  };
  return { json, agrees: fit.ciHigh < 0 || summary.alarmIndex !== null || (summary.mkPValue < 0.05 && summary.mkTau < 0) };
}

export interface CurveInput {
  readonly start: number;
  readonly points: readonly ChargeCurvePoint[];
}

/**
 * 대표 충전 곡선: 용량 추정값이 중앙값에 가까운 표본부터, 그 표본 구간 안에서 시작한 충전 세션 중 곡선이 있는 첫 세션
 * (세션 방식은 표본 = 세션, 휴지 앵커는 충전 방향 쌍 안의 충전). 곡선이 없으면 null
 */
export function curveFor(curves: readonly CurveInput[] | undefined, sessions: readonly EssChargeEpisode[], samples: readonly CapacitySample[]): JsonObject | null {
  if (samples.length === 0 || !curves || curves.length === 0) return null;
  const center = median(samples.map((s) => s.value));
  const ranked = [...samples].sort((a, b) => Math.abs(a.value - center) - Math.abs(b.value - center));
  for (const sample of ranked) {
    const session = sessions.find((s) => s.start >= sample.start && s.start < sample.end);
    const curve = session ? curves.find((c) => c.start === session.start) : undefined;
    if (!curve) continue;
    return {
      start: curve.start,
      capacity_ah: r(sample.value, 2),
      points: downsample(curve.points, 120).map((pt) => ({ elapsed_s: pt.elapsed_s, ah: r(pt.ah, 2), soc: r(pt.soc, 2) })),
    };
  }
  return null;
}

/** bin 표: 비교 통계(matchedRatio) + bin별 기준·최근 기간과 제외 이유 */
export function binsEvidence(matched: MatchedRatioOk, references: readonly BinReference[]): JsonObject[] {
  const keys = [...new Set([...references.map((b) => b.key), ...matched.bins.map((b) => b.key)])].sort();
  return keys.map((key) => {
    const stat = matched.bins.find((b) => b.key === key);
    const ref = references.find((b) => b.key === key);
    return {
      key,
      n_ref: stat?.nRef ?? ref?.nRef ?? 0,
      n_cur: stat?.nCur ?? ref?.nCur ?? 0,
      med_ref: r(stat?.medRef ?? null, 2),
      med_cur: r(stat?.medCur ?? null, 2),
      ratio: r(stat?.ratio ?? null, 4),
      used: stat?.used ?? false,
      weight: r(stat?.weight ?? 0, 4),
      ref_from: ref?.refFrom ?? null,
      ref_to: ref?.refTo ?? null,
      cur_from: ref?.curFrom ?? null,
      cur_to: ref?.curTo ?? null,
      excluded: ref?.excluded ?? null,
    };
  });
}

/** 기준 전류 환산용: 기준 기간 충전 세션의 CC 전류 중앙값 [A] (세션이 없으면 null) */
export function referenceCurrentA(sessions: readonly EssChargeEpisode[], ranges: readonly { readonly from: number; readonly to: number }[], ratedCapacityAh: number): number | null {
  const inside = sessions.filter((s) => s.valid && ranges.some((range) => s.start >= range.from && s.start <= range.to));
  return inside.length === 0 ? null : median(inside.map((s) => s.features.i_mean_c)) * ratedCapacityAh;
}
