// 연료전지 공기 블로워 정상운전 에피소드: fc.blower_run@1 (fc.blower_wear 입력).
// 정상운전 = 공기 유량 ≥ minFlowKgH이고 구간 평균 ±steadyTolerance 안에서 steadyMinS 이상 유지 (스택 정상운전과 같은 규칙을 유량에 적용).
// 비전력 = 블로워 전력 ÷ 공기 유량 [W/(kg/h)]. 같은 유량에서 비전력이 오르면 필터 막힘·베어링·임펠러 마모를 의심한다.
// 입력 메트릭 (블로워 + 사이트 기상 + 형제 스택): blower.flow(kg/h, 필수) · blower.power(kW, 필수) · ambient.temp(°C) · run.hours(h, 스택 누적 운전시간)
import { MS_PER_HOUR, MS_PER_SECOND } from '../types';
import { binFloor, goodPoints, meanValue, metricDq, nominalPeriodMs, pointsIn, round, roundOrNull, valueNear, worstDq } from './series';
import { DEFAULT_STACK_RUN_RULES, steadyWindows } from './stack';
import { extractorId, validity, type Episode, type ExtractInput } from './types';

export interface FcBlowerNameplate {
  readonly rated_kw: number;
}

export interface FcBlowerRunParams {
  readonly minFlowKgH: number;
  readonly steadyTolerance: number;
  readonly steadyMinS: number;
  readonly maxGapS: number;
  readonly fallbackPeriodS: number;
  readonly flowBinWidthKgH: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
}

export const DEFAULT_FC_BLOWER_RUN_PARAMS: FcBlowerRunParams = Object.freeze({
  minFlowKgH: 50,
  steadyTolerance: 0.05,
  steadyMinS: 900,
  maxGapS: 600,
  fallbackPeriodS: 300,
  flowBinWidthKgH: 100,
  tempBinWidthC: 5,
  minCompleteness: 0.8,
});

export type FcBlowerRunFeatures = {
  readonly duration_s: number;
  readonly flow_kg_h: number;
  readonly power_kw: number | null;
  readonly specific_w_per_kg_h: number | null;
  readonly ambient_c: number | null;
  readonly op_hours_cum: number | null;
};
export type FcBlowerRunConditions = { readonly flow_bin: number; readonly t_bin: number | null };
export type FcBlowerRunEpisode = Episode<'fc.blower_run', FcBlowerRunFeatures, FcBlowerRunConditions>;

/** 원시 샘플 → fc.blower_run 에피소드. 유량 샘플이 없으면 빈 결과 */
export function extractBlowerRuns(input: ExtractInput<FcBlowerNameplate>, overrides: Partial<FcBlowerRunParams> = {}): FcBlowerRunEpisode[] {
  const p = { ...DEFAULT_FC_BLOWER_RUN_PARAMS, ...overrides };
  if (!(input.nameplate.rated_kw > 0)) throw new RangeError('fc.blower_run 추출: 블로워 정격(rated_kw)이 올바르지 않습니다');
  if (!(p.minFlowKgH > 0)) throw new RangeError('fc.blower_run 추출: minFlowKgH는 0보다 커야 합니다');
  const flow = pointsIn(goodPoints(input.series, 'blower.flow'), input.window);
  const power = goodPoints(input.series, 'blower.power');
  const ambient = goodPoints(input.series, 'ambient.temp');
  const runHours = goodPoints(input.series, 'run.hours');
  const periodMs = nominalPeriodMs(flow, p.fallbackPeriodS * MS_PER_SECOND);
  // 스택 규칙의 '정격 × runningFraction' 문턱을 유량 하한으로 쓴다
  const rules = { ...DEFAULT_STACK_RUN_RULES, steadyTolerance: p.steadyTolerance, steadyMinS: p.steadyMinS, maxGapS: p.maxGapS, runningFraction: 1 };
  return steadyWindows(flow, input.window, p.minFlowKgH, periodMs, rules).map((w): FcBlowerRunEpisode => {
    const flowMean = meanValue(pointsIn(flow, w)) ?? w.meanCurrentA;
    const powerMean = meanValue(pointsIn(power, w));
    const midpoint = (w.start + w.end) / 2;
    const ambientC = meanValue(pointsIn(ambient, w)) ?? valueNear(ambient, midpoint, MS_PER_HOUR);
    const dq = worstDq(['blower.flow', 'blower.power'].map((metric) => metricDq(input.series[metric], w, periodMs)));
    return {
      assetId: input.assetId,
      kind: 'fc.blower_run',
      extractorVersion: extractorId('fc.blower_run'),
      start: w.start,
      end: w.end,
      features: {
        duration_s: (w.end - w.start) / MS_PER_SECOND,
        flow_kg_h: round(flowMean, 3),
        power_kw: roundOrNull(powerMean, 4),
        specific_w_per_kg_h: powerMean === null || !(flowMean > 0) ? null : round((powerMean * 1000) / flowMean, 5),
        ambient_c: roundOrNull(ambientC, 3),
        op_hours_cum: roundOrNull(valueNear(runHours, midpoint, MS_PER_HOUR), 3),
      },
      conditions: { flow_bin: binFloor(flowMean, p.flowBinWidthKgH), t_bin: ambientC === null ? null : binFloor(ambientC, p.tempBinWidthC) },
      dq,
      open: w.open,
      ...validity(w.open, dq.completeness, p.minCompleteness),
    };
  });
}
