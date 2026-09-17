// dq.gap_flatline@1 — 포인트별 결측 구간·값 고착 구간 요약(다음 단계가 SQL로 준비) → 설비 단위 데이터 품질 finding.
// 데이터 품질도 코칭 항목이다 (설계 §4.1): 통신 점검·센서 교정을 권고한다. severity 2 고정, category data_quality.
import * as z from 'zod';
import { hashInput } from '../hash';
import { MS_PER_HOUR, type TimeWindow } from '../types';
import { fixed, insufficient, r, withDefaults } from './common';
import { intParam, numParam } from './param-schema';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult } from './types';

export interface DqPointSummary {
  readonly pointId: number;
  readonly assetId: number;
  readonly metricKey: string;
  readonly sourceKey: string;
  readonly expectedSamples: number;
  /** 창 안에서 받은 샘플 수 (값 null 제외) */
  readonly receivedSamples: number;
  /** 공칭 주기보다 크게 벌어진 결측 구간 */
  readonly gaps: readonly TimeWindow[];
  /** 값이 metric_def.flatline_max_s 넘게 그대로인 구간 */
  readonly flatlines: readonly (TimeWindow & { readonly value: number })[];
}

export interface DqGapFlatlineInput {
  readonly siteId: number;
  readonly window: TimeWindow;
  readonly points: readonly DqPointSummary[];
}

export interface DqGapFlatlineParams {
  /** 포인트 완결성이 이 값 미만이면 결측 문제 */
  readonly minCompleteness: number;
  /** 결측 구간 합계가 이 시간 이상이면 결측 문제 [h] */
  readonly minGapHours: number;
  /** 고착 구간 하나가 이 시간 이상이면 고착 문제 [h] */
  readonly minFlatlineHours: number;
  /** 근거에 적는 포인트 수 상한 */
  readonly maxListed: number;
}

export const DQ_GAP_FLATLINE_DEFAULTS: DqGapFlatlineParams = Object.freeze({
  minCompleteness: 0.95,
  minGapHours: 2,
  minFlatlineHours: 6,
  maxListed: 10,
});

export const DQ_GAP_FLATLINE_PARAM_SCHEMA = z.object({
  minCompleteness: numParam(DQ_GAP_FLATLINE_DEFAULTS.minCompleteness, { label: '최소 수신 완결성', unit: '', min: 0, max: 1, description: '포인트의 기대 샘플 대비 수신 비율이 이 값 미만이면 결측 문제로 봅니다.' }),
  minGapHours: numParam(DQ_GAP_FLATLINE_DEFAULTS.minGapHours, { label: '결측 합계 기준', unit: 'h', min: 0, max: 168, description: '공칭 주기보다 크게 벌어진 결측 구간 합계가 이 시간 이상이면 결측 문제로 봅니다.' }),
  minFlatlineHours: numParam(DQ_GAP_FLATLINE_DEFAULTS.minFlatlineHours, { label: '고착 구간 기준', unit: 'h', min: 0, max: 168, description: '값이 그대로인 구간 하나가 이 시간 이상이면 센서 고착으로 봅니다.' }),
  maxListed: intParam(DQ_GAP_FLATLINE_DEFAULTS.maxListed, { label: '근거 포인트 수 상한', unit: '개', min: 1, max: 100, description: '근거 스냅샷에 적는 문제 포인트 수 상한입니다.' }),
});

const META = { id: 'dq.gap_flatline', version: '1', failureMode: 'dq.data_gap_flatline', category: 'data_quality' } as const;
/** 직접 관측한 사실이라 통계 신뢰도 대신 고정값을 쓴다 */
const DQ_CONFIDENCE = 0.9;

const hoursOf = (spans: readonly TimeWindow[]): number => spans.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0) / MS_PER_HOUR;
const completenessOf = (pt: DqPointSummary): number => (pt.expectedSamples > 0 ? Math.min(1, pt.receivedSamples / pt.expectedSamples) : 1);
const longestFlatline = (pt: DqPointSummary): number => Math.max(0, ...pt.flatlines.map((f) => (f.end - f.start) / MS_PER_HOUR));

function findingFor(assetId: number, points: readonly DqPointSummary[], input: DqGapFlatlineInput, p: DqGapFlatlineParams): CandidateFinding | null {
  const gapPoints = points.filter((pt) => completenessOf(pt) < p.minCompleteness || hoursOf(pt.gaps) >= p.minGapHours);
  const flatPoints = points.filter((pt) => longestFlatline(pt) >= p.minFlatlineHours).sort((a, b) => longestFlatline(b) - longestFlatline(a));
  if (gapPoints.length === 0 && flatPoints.length === 0) return null;

  const expected = points.reduce((sum, pt) => sum + pt.expectedSamples, 0);
  const received = points.reduce((sum, pt) => sum + Math.min(pt.receivedSamples, pt.expectedSamples), 0);
  const completenessPct = expected > 0 ? (received / expected) * 100 : 100;
  const gapHours = Math.max(0, ...gapPoints.map((pt) => hoursOf(pt.gaps)));
  const days = (input.window.end - input.window.start) / (24 * MS_PER_HOUR);
  const worstFlat = flatPoints[0];
  const parts = [
    gapPoints.length > 0 ? `최근 ${fixed(days, 0)}일 수신 완결성 ${fixed(completenessPct, 1)}%(결측 최대 ${fixed(gapHours, 1)}시간, 포인트 ${gapPoints.length}개)` : null,
    worstFlat ? `값 고착 포인트 ${flatPoints.length}개(최장 ${fixed(longestFlatline(worstFlat), 1)}시간: ${worstFlat.sourceKey})` : null,
  ].filter((part): part is string => part !== null);
  const advice = [gapPoints.length > 0 ? '게이트웨이·통신 경로 점검' : null, flatPoints.length > 0 ? '센서 교정·배선 점검' : null].filter((a): a is string => a !== null).join('과 ');
  const listed = [...new Set([...gapPoints, ...flatPoints])].slice(0, p.maxListed);
  const titleParts = [gapPoints.length > 0 ? '수신 결측' : null, flatPoints.length > 0 ? '센서 값 고착' : null].filter((t): t is string => t !== null);

  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity: 2,
    confidence: DQ_CONFIDENCE,
    title: `데이터 품질: ${titleParts.join('·')}`,
    summary: `${parts.join(', ')}. ${advice}을 권고합니다.`,
    effect: gapPoints.length > 0
      // 효과 값은 다른 탐지기와 같이 '기준 대비 변화량'이다 (완결성 100% → 91.67%면 -8.33%p).
      // 수준(91.67%)을 그대로 넣으면 화면 효과 칩이 '+91.67%'가 되어 완결성이 오른 것처럼 읽힌다.
      ? { metric: 'dq.completeness', value: r(completenessPct - 100, 2) ?? 0, unit: '%p', ciLow: null, ciHigh: null, baseline: 100, current: r(completenessPct, 2), levelUnit: '%' }
      : { metric: 'dq.flatline_hours', value: r(longestFlatline(worstFlat as DqPointSummary), 2) ?? 0, unit: 'h', ciLow: null, ciHigh: null, baseline: null, current: null, levelUnit: null },
    windowStart: input.window.start,
    windowEnd: input.window.end,
    evidence: {
      method: 'gap_flatline_summary',
      points: listed.map((pt) => ({
        point_id: pt.pointId,
        source_key: pt.sourceKey,
        metric_key: pt.metricKey,
        completeness: r(completenessOf(pt), 4),
        gap_hours: r(hoursOf(pt.gaps), 2),
        gaps: pt.gaps.slice(0, 20).map((g) => ({ start: g.start, end: g.end })),
        longest_flatline_hours: r(longestFlatline(pt), 2),
        flatlines: pt.flatlines.slice(0, 20).map((f) => ({ start: f.start, end: f.end, value: r(f.value, 4) })),
      })),
      gap_points: gapPoints.length,
      flatline_points: flatPoints.length,
    },
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, window: input.window, points }),
  };
}

function detect(input: DqGapFlatlineInput, ctx: DetectorContext<DqGapFlatlineParams>): DetectorResult {
  const p = withDefaults(DQ_GAP_FLATLINE_DEFAULTS, ctx.params);
  if (input.points.length === 0) return insufficient('데이터 품질을 평가할 포인트가 없습니다');
  const assetIds = [...new Set(input.points.map((pt) => pt.assetId))].sort((a, b) => a - b);
  const findings = assetIds.flatMap((assetId) => {
    const finding = findingFor(assetId, input.points.filter((pt) => pt.assetId === assetId), input, p);
    return finding ? [finding] : [];
  });
  return { status: 'ok', findings };
}

export const dqGapFlatline: Detector<DqGapFlatlineInput, DqGapFlatlineParams> = {
  ...META,
  // 매핑된 모든 포인트가 대상이라 필수 메트릭이 없다. 결측·고착 판정은 포인트 자기 period_s로 하므로 주기 상한도 없다.
  requires: { assetClass: [], metrics: [], minHistoryDays: 1 },
  defaultParams: DQ_GAP_FLATLINE_DEFAULTS,
  paramSchema: DQ_GAP_FLATLINE_PARAM_SCHEMA,
  detect,
};
