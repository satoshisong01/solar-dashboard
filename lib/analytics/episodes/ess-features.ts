// ESS 에피소드 특징 계산 (순수). 적분은 0차 유지, 전류 부호는 충전 +.
import { median } from '../stats/robust';
import { MS_PER_HOUR, MS_PER_SECOND, type AssetSeries, type TimeWindow } from '../types';
import type { Segment } from './ess-activity';
import {
  downsample,
  goodPoints,
  holdIntegral,
  meanValue,
  nominalPeriodMs,
  pointsIn,
  round,
  valueAtOrAfter,
  valueAtOrBefore,
  valueNear,
  type TimedValue,
} from './series';

export interface EssSignals {
  readonly current: readonly TimedValue[];
  readonly voltage: readonly TimedValue[];
  readonly soc: readonly TimedValue[];
  readonly cellTemp: readonly TimedValue[];
  readonly cellMax: readonly TimedValue[];
  readonly cellMin: readonly TimedValue[];
  readonly periodMs: number;
  readonly maxGapMs: number;
  readonly capacityAh: number;
}

export type EssChargeFeatures = {
  /** 충전 Ah (부호 포함 적분) */
  readonly ah_in: number;
  readonly wh_in: number | null;
  /** CC 구간 평균 전류 / 정격 용량 (CC 구간이 없으면 전체 평균) */
  readonly i_mean_c: number;
  readonly t_cell_mean: number | null;
  readonly soc_start: number | null;
  readonly soc_end: number | null;
  /** 휴지 후 시작일 때 휴지 끝 SOC (BMS가 휴지 OCV로 재보정한 값으로 본다) */
  readonly soc_ocv_start: number | null;
  /** 테이퍼 시작 전까지 Ah */
  readonly cc_ah: number;
  /** 상한 도달 후 전류 테이퍼(CV) 시간 [s] */
  readonly cv_s: number;
  readonly soc_cv_start: number | null;
  readonly duration_s: number;
  /** 종료 시 최고−최저 셀 전압 [mV] */
  readonly cell_dv_end: number | null;
  /** 앵커 세션일 때 ah_in / (1 − soc_start/100) */
  readonly capacity_ah_anchored: number | null;
  /** CC 구간 Ah 보조 용량: cc_ah / ((soc_cv_start − soc_start)/100) */
  readonly capacity_ah_cc: number | null;
  /** 부분 충전 쿨롱 카운팅 용량: ah_in / ((soc_end − soc_start)/100). SOC 변화가 minSocSpanPct 이상이고 휴지로 끝난 세션만 */
  readonly capacity_ah_soc: number | null;
};

export type EssDischargeFeatures = {
  readonly ah_out: number;
  readonly wh_out: number | null;
  readonly i_mean_c: number;
  readonly t_cell_mean: number | null;
  readonly soc_start: number | null;
  readonly soc_end: number | null;
  readonly duration_s: number;
  readonly cell_dv_end: number | null;
};

export type EssRestFeatures = {
  readonly duration_s: number;
  readonly soc_mean: number | null;
  /** 휴지 끝 SOC (BMS가 휴지 OCV로 재보정했을 가능성이 높은 시점, ess.capacity_fade 휴지 앵커) */
  readonly soc_end: number | null;
  /** 휴지 구간 전류 적분 [Ah] (|I| ≤ 임계 전류와 짧은 블립, 충전 +) */
  readonly ah_net: number;
  readonly t_cell_mean: number | null;
  readonly cell_dv_end: number | null;
  readonly v_end: number | null;
};

interface TaperRules {
  readonly taperFraction: number;
  readonly topSocPct: number;
  readonly cellVoltageMaxV: number;
  readonly cellVoltageToleranceV: number;
  readonly minCcSocSpanPct: number;
  readonly minSocSpanPct: number;
}

const toleranceOf = (signals: EssSignals): number => Math.max(2 * signals.periodMs, signals.maxGapMs);

function ahOf(signals: EssSignals, range: TimeWindow): number {
  return holdIntegral(signals.current, range, signals.periodMs, signals.maxGapMs);
}

/** 전력량 [Wh] = ∫ I·V dt. 전압을 못 찾는 전류 샘플이 10%를 넘으면 null */
function whOf(signals: EssSignals, range: TimeWindow): number | null {
  const points = pointsIn(signals.current, range);
  const tolerance = toleranceOf(signals);
  const voltageAt = (p: TimedValue) => valueNear(signals.voltage, p.ts, tolerance);
  const missing = points.filter((p) => voltageAt(p) === null).length;
  if (points.length === 0 || missing > 0.1 * points.length) return null;
  return holdIntegral(signals.current, range, signals.periodMs, signals.maxGapMs, (p) => p.value * (voltageAt(p) ?? 0));
}

function cellDvMv(signals: EssSignals, ts: number): number | null {
  const tolerance = toleranceOf(signals);
  const max = valueAtOrBefore(signals.cellMax, ts, tolerance);
  const min = valueAtOrBefore(signals.cellMin, ts, tolerance);
  return max === null || min === null ? null : round((max - min) * 1000, 2);
}

/** 테이퍼 시작 시각: CC 전류(앞 절반 중앙값)의 taperFraction 이상인 마지막 샘플 다음. 끝까지 CC면 null */
function taperStart(points: readonly TimedValue[], taperFraction: number): number | null {
  const charging = points.filter((p) => p.value > 0);
  if (charging.length < 3) return null;
  const ccLevel = median(charging.slice(0, Math.ceil(charging.length / 2)).map((p) => p.value));
  const lastHigh = points.findLastIndex((p) => p.value > taperFraction * ccLevel);
  return points[lastHigh + 1]?.ts ?? null;
}

export function chargeFeatures(signals: EssSignals, segment: Segment, rules: TaperRules): { features: EssChargeFeatures; cvEnd: boolean } {
  const tolerance = toleranceOf(signals);
  const points = pointsIn(signals.current, segment);
  const socStart = valueAtOrAfter(signals.soc, segment.start, tolerance);
  const socEnd = valueAtOrBefore(signals.soc, segment.end, tolerance);
  const cellMaxEnd = valueAtOrBefore(signals.cellMax, segment.end, tolerance);
  const topReached = (socEnd !== null && socEnd >= rules.topSocPct) || (cellMaxEnd !== null && cellMaxEnd >= rules.cellVoltageMaxV - rules.cellVoltageToleranceV);
  const taper = taperStart(points, rules.taperFraction);
  const cvEnd = taper !== null && topReached;
  const ccEnd = cvEnd && taper !== null ? taper : segment.end;
  const ccRange = { start: segment.start, end: ccEnd };
  const ccAh = ahOf(signals, ccRange);
  const socCvStart = cvEnd ? valueNear(signals.soc, ccEnd, tolerance) : null;
  const span = socCvStart !== null && socStart !== null ? socCvStart - socStart : null;
  const ccMean = meanValue(pointsIn(signals.current, ccRange)) ?? meanValue(points) ?? 0;
  const ahIn = ahOf(signals, segment);
  const socSpan = socStart !== null && socEnd !== null ? socEnd - socStart : null;
  return {
    cvEnd,
    features: {
      ah_in: ahIn,
      wh_in: whOf(signals, segment),
      i_mean_c: ccMean / signals.capacityAh,
      t_cell_mean: meanValue(pointsIn(signals.cellTemp, segment)),
      soc_start: socStart,
      soc_end: socEnd,
      soc_ocv_start: valueAtOrBefore(signals.soc, segment.start - 1, tolerance),
      cc_ah: ccAh,
      cv_s: (segment.end - ccEnd) / MS_PER_SECOND,
      soc_cv_start: socCvStart,
      duration_s: (segment.end - segment.start) / MS_PER_SECOND,
      cell_dv_end: cellDvMv(signals, segment.end),
      capacity_ah_anchored: null,
      capacity_ah_cc: span !== null && span >= rules.minCcSocSpanPct ? ccAh / (span / 100) : null,
      capacity_ah_soc: socSpan !== null && socSpan >= rules.minSocSpanPct && segment.endReason === 'rest' ? ahIn / (socSpan / 100) : null,
    },
  };
}

export function dischargeFeatures(signals: EssSignals, segment: TimeWindow): EssDischargeFeatures {
  const tolerance = toleranceOf(signals);
  const wh = whOf(signals, segment);
  return {
    ah_out: -ahOf(signals, segment),
    wh_out: wh === null ? null : -wh,
    i_mean_c: Math.abs(meanValue(pointsIn(signals.current, segment)) ?? 0) / signals.capacityAh,
    t_cell_mean: meanValue(pointsIn(signals.cellTemp, segment)),
    soc_start: valueAtOrAfter(signals.soc, segment.start, tolerance),
    soc_end: valueAtOrBefore(signals.soc, segment.end, tolerance),
    duration_s: (segment.end - segment.start) / MS_PER_SECOND,
    cell_dv_end: cellDvMv(signals, segment.end),
  };
}

export function restFeatures(signals: EssSignals, segment: TimeWindow): EssRestFeatures {
  const tolerance = toleranceOf(signals);
  return {
    duration_s: (segment.end - segment.start) / MS_PER_SECOND,
    soc_mean: meanValue(pointsIn(signals.soc, segment)),
    soc_end: valueAtOrBefore(signals.soc, segment.end - 1, tolerance),
    ah_net: ahOf(signals, segment),
    t_cell_mean: meanValue(pointsIn(signals.cellTemp, segment)),
    cell_dv_end: cellDvMv(signals, segment.end - 1),
    v_end: valueAtOrBefore(signals.voltage, segment.end - 1, tolerance),
  };
}

export type ChargeCurvePoint = { readonly elapsed_s: number; readonly ah: number; readonly soc: number | null };

/** 에피소드 오버레이용 충전 곡선: t=0 정렬 경과시간·누적 Ah·SOC, maxPoints개 이하 */
export function chargeCurve(series: AssetSeries, range: TimeWindow, options: { maxPoints?: number; maxGapS?: number; fallbackPeriodS?: number } = {}): ChargeCurvePoint[] {
  const current = goodPoints(series, 'batt.current');
  const soc = goodPoints(series, 'batt.soc');
  const periodMs = nominalPeriodMs(current, (options.fallbackPeriodS ?? 60) * MS_PER_SECOND);
  const maxGapMs = (options.maxGapS ?? 120) * MS_PER_SECOND;
  const points = pointsIn(current, range);
  let cumulativeAh = 0;
  const curve = points.map((p, i): ChargeCurvePoint => {
    const next = points[i + 1];
    const row = { elapsed_s: (p.ts - range.start) / MS_PER_SECOND, ah: round(cumulativeAh, 3), soc: valueNear(soc, p.ts, 2 * periodMs) };
    const step = next && next.ts - p.ts <= maxGapMs ? next.ts - p.ts : periodMs;
    cumulativeAh += (p.value * Math.min(step, range.end - p.ts)) / MS_PER_HOUR;
    return row;
  });
  const last = points[points.length - 1];
  const final: ChargeCurvePoint[] = last ? [{ elapsed_s: (range.end - range.start) / MS_PER_SECOND, ah: round(cumulativeAh, 3), soc: valueNear(soc, range.end, 2 * periodMs) }] : [];
  return downsample([...curve, ...final], options.maxPoints ?? 120);
}
