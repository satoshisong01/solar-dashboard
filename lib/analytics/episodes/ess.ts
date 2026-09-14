// ESS 랙 에피소드 추출기: ess.charge@1 · ess.discharge@1 · ess.rest@2 (설계 §3.1).
// 입력 메트릭: batt.current(충전 +, 필수) · batt.voltage · batt.soc(%) · cell.temp.avg · cell.voltage.max/min(V)
import { MS_PER_SECOND, type TimeWindow } from '../types';
import { activeSegments, activityRuns, restSegments, type Segment, type SegmentRules } from './ess-activity';
import { chargeFeatures, dischargeFeatures, restFeatures, type EssChargeFeatures, type EssDischargeFeatures, type EssRestFeatures, type EssSignals } from './ess-features';
import { binFloor, goodPoints, metricDq, nominalPeriodMs, pointsIn, worstDq } from './series';
import { extractorId, validity, type Episode, type EpisodeDq, type ExtractInput } from './types';

export interface EssRackNameplate {
  /** 랙 정격 용량 [Ah] — C-rate 기준 */
  readonly capacity_ah: number;
}

export interface EssExtractorParams {
  readonly thresholdC: number;
  readonly minActiveS: number;
  readonly minRestS: number;
  readonly maxGapS: number;
  readonly preRestS: number;
  readonly fallbackPeriodS: number;
  /** 충전 말 테이퍼 판정: CC 전류의 이 비율 아래로 끝까지 유지되면 테이퍼 */
  readonly taperFraction: number;
  /** 상한 도달 판정: 종료 SOC가 이 값 이상이거나 최고 셀 전압이 (셀 상한 − 허용오차) 이상 */
  readonly topSocPct: number;
  readonly cellVoltageMaxV: number;
  readonly cellVoltageToleranceV: number;
  readonly anchorSocMaxPct: number;
  readonly anchorMinCompleteness: number;
  /** CC 구간 Ah 보조 용량: 테이퍼 시작 SOC − 시작 SOC가 이 폭 이상일 때만 */
  readonly minCcSocSpanPct: number;
  /** 부분 충전 쿨롱 카운팅 용량(capacity_ah_soc): 충전 중 SOC 변화가 이 폭 이상일 때만 */
  readonly minSocSpanPct: number;
  readonly cRateBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
}

export const DEFAULT_ESS_EXTRACTOR_PARAMS: EssExtractorParams = Object.freeze({
  thresholdC: 0.02,
  minActiveS: 120,
  minRestS: 300,
  maxGapS: 120,
  preRestS: 3600,
  fallbackPeriodS: 60,
  taperFraction: 0.9,
  topSocPct: 97,
  cellVoltageMaxV: 3.55,
  cellVoltageToleranceV: 0.03,
  anchorSocMaxPct: 20,
  anchorMinCompleteness: 0.95,
  minCcSocSpanPct: 40,
  minSocSpanPct: 40,
  cRateBinWidth: 0.05,
  tempBinWidthC: 5,
  minCompleteness: 0.8,
});

export type EssChargeConditions = {
  readonly c_rate_bin: number;
  readonly t_cell_bin: number | null;
  readonly anchor: boolean;
  readonly pre_rest: boolean;
  readonly cv_end: boolean;
  readonly end_reason: Segment['endReason'];
};
export type EssDischargeConditions = Omit<EssChargeConditions, 'anchor' | 'cv_end'>;
export type EssRestConditions = { readonly t_cell_bin: number | null; readonly end_reason: Segment['endReason'] };

export type EssChargeEpisode = Episode<'ess.charge', EssChargeFeatures, EssChargeConditions>;
export type EssDischargeEpisode = Episode<'ess.discharge', EssDischargeFeatures, EssDischargeConditions>;
export type EssRestEpisode = Episode<'ess.rest', EssRestFeatures, EssRestConditions>;

export interface EssEpisodes {
  readonly charges: readonly EssChargeEpisode[];
  readonly discharges: readonly EssDischargeEpisode[];
  readonly rests: readonly EssRestEpisode[];
}

const REQUIRED = ['batt.current', 'batt.voltage', 'batt.soc'] as const;

function signalsOf(input: ExtractInput<EssRackNameplate>, params: EssExtractorParams): EssSignals {
  const current = goodPoints(input.series, 'batt.current');
  return {
    current,
    voltage: goodPoints(input.series, 'batt.voltage'),
    soc: goodPoints(input.series, 'batt.soc'),
    cellTemp: goodPoints(input.series, 'cell.temp.avg'),
    cellMax: goodPoints(input.series, 'cell.voltage.max'),
    cellMin: goodPoints(input.series, 'cell.voltage.min'),
    periodMs: nominalPeriodMs(current, params.fallbackPeriodS * MS_PER_SECOND),
    maxGapMs: params.maxGapS * MS_PER_SECOND,
    capacityAh: input.nameplate.capacity_ah,
  };
}

function segmentDq(input: ExtractInput<EssRackNameplate>, range: TimeWindow, periodMs: number): EpisodeDq {
  return worstDq(REQUIRED.map((metric) => metricDq(input.series[metric], range, periodMs)));
}

/** 창 시작 직후에 시작했거나, 창 끝까지 이어져 끝났으면 경계에 걸린 것 */
function isOpen(segment: Segment, window: TimeWindow, toleranceMs: number): boolean {
  return segment.start - window.start <= toleranceMs || (segment.endReason === 'data_end' && window.end - segment.end <= toleranceMs);
}

/** 시작 전 preRest 동안 |I| ≤ 임계이고 샘플이 90% 이상 있으면 휴지 후 시작 */
function startsAfterRest(signals: EssSignals, start: number, thresholdA: number, params: EssExtractorParams): boolean {
  const range = { start: start - params.preRestS * MS_PER_SECOND, end: start };
  const points = pointsIn(signals.current, range);
  const expected = (range.end - range.start) / signals.periodMs;
  return points.length >= 0.9 * expected && points.every((p) => Math.abs(p.value) <= thresholdA);
}

interface Common {
  readonly segment: Segment;
  readonly dq: EpisodeDq;
  readonly open: boolean;
  readonly preRest: boolean;
}

function commonOf(input: ExtractInput<EssRackNameplate>, signals: EssSignals, segment: Segment, params: EssExtractorParams): Common {
  const thresholdA = params.thresholdC * input.nameplate.capacity_ah;
  return {
    segment,
    dq: segmentDq(input, segment, signals.periodMs),
    open: isOpen(segment, input.window, signals.periodMs + signals.maxGapMs),
    preRest: startsAfterRest(signals, segment.start, thresholdA, params),
  };
}

function baseEpisode<K extends 'ess.charge' | 'ess.discharge' | 'ess.rest'>(assetId: number, kind: K, common: Common, params: EssExtractorParams) {
  return {
    assetId,
    kind,
    extractorVersion: extractorId(kind),
    start: common.segment.start,
    end: common.segment.end,
    dq: common.dq,
    open: common.open,
    ...validity(common.open, common.dq.completeness, params.minCompleteness),
  };
}

const tempBin = (t: number | null, width: number): number | null => (t === null ? null : binFloor(t, width));

function buildCharge(input: ExtractInput<EssRackNameplate>, signals: EssSignals, common: Common, params: EssExtractorParams): EssChargeEpisode {
  const base = baseEpisode(input.assetId, 'ess.charge', common, params);
  const derived = chargeFeatures(signals, common.segment, params);
  const anchor =
    base.valid &&
    common.preRest &&
    derived.cvEnd &&
    common.segment.endReason === 'rest' &&
    derived.features.soc_start !== null &&
    derived.features.soc_start <= params.anchorSocMaxPct &&
    common.dq.completeness >= params.anchorMinCompleteness;
  const socStart = derived.features.soc_start ?? 0;
  const features: EssChargeFeatures = {
    ...derived.features,
    soc_ocv_start: common.preRest ? derived.features.soc_ocv_start : null,
    capacity_ah_anchored: anchor ? derived.features.ah_in / (1 - socStart / 100) : null,
  };
  const conditions: EssChargeConditions = {
    c_rate_bin: binFloor(features.i_mean_c, params.cRateBinWidth),
    t_cell_bin: tempBin(features.t_cell_mean, params.tempBinWidthC),
    anchor,
    pre_rest: common.preRest,
    cv_end: derived.cvEnd && common.segment.endReason === 'rest',
    end_reason: common.segment.endReason,
  };
  return { ...base, features, conditions };
}

/** 원시 샘플 → ESS 에피소드. 전류 샘플이 없으면 빈 결과 */
export function extractEssEpisodes(input: ExtractInput<EssRackNameplate>, overrides: Partial<EssExtractorParams> = {}): EssEpisodes {
  const params = { ...DEFAULT_ESS_EXTRACTOR_PARAMS, ...overrides };
  if (!(input.nameplate.capacity_ah > 0)) throw new RangeError(`ESS 추출: 정격 용량이 올바르지 않습니다 (${input.nameplate.capacity_ah})`);
  const signals = signalsOf(input, params);
  const rules: SegmentRules = {
    thresholdA: params.thresholdC * input.nameplate.capacity_ah,
    periodMs: signals.periodMs,
    maxGapMs: signals.maxGapMs,
    minActiveMs: params.minActiveS * MS_PER_SECOND,
    minRestMs: params.minRestS * MS_PER_SECOND,
  };
  const inWindow = pointsIn(signals.current, input.window);
  const runs = activityRuns(inWindow, rules);
  const chargeSegments = activeSegments(runs, 'charge', rules);
  const dischargeSegments = activeSegments(runs, 'discharge', rules);
  const restSegs = restSegments(runs, [...chargeSegments, ...dischargeSegments], rules);

  const charges = chargeSegments.map((s) => buildCharge(input, signals, commonOf(input, signals, s, params), params));
  const discharges = dischargeSegments.map((s): EssDischargeEpisode => {
    const common = commonOf(input, signals, s, params);
    const features = dischargeFeatures(signals, s);
    const conditions: EssDischargeConditions = {
      c_rate_bin: binFloor(features.i_mean_c, params.cRateBinWidth),
      t_cell_bin: tempBin(features.t_cell_mean, params.tempBinWidthC),
      pre_rest: common.preRest,
      end_reason: s.endReason,
    };
    return { ...baseEpisode(input.assetId, 'ess.discharge', common, params), features, conditions };
  });
  const rests = restSegs.map((s): EssRestEpisode => {
    const common = commonOf(input, signals, s, params);
    const features = restFeatures(signals, s);
    return { ...baseEpisode(input.assetId, 'ess.rest', common, params), features, conditions: { t_cell_bin: tempBin(features.t_cell_mean, params.tempBinWidthC), end_reason: s.endReason } };
  });
  return { charges, discharges, rests };
}
