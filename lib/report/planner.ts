// 리포트 계획 규칙 (순수): 판정 수준(확정·잠정·판정 보류), 추정 영향, 우선순위, 할 일 3개.
// 설계 §4.1 Planner/Composer 분리 — 이 규칙은 결정적이고, 문장을 바꾸는 Composer는 여기 결과를 바꿀 수 없다.
import { MS_PER_DAY } from '@/lib/analytics/types';
import { roundTo } from './pack-evidence';
import type { DataSpan, Judgement, PackEvidence, PackFinding, PackTodo } from './pack-types';

/** 확정 판정: 신뢰도 이상 + 같은 문제를 이 횟수 이상 반복 탐지 */
export const CONFIRMED_CONFIDENCE = 0.7;
export const CONFIRMED_DETECTIONS = 2;
export const TODO_LIMIT = 3;
/** 심각도 이 값 이상은 리포트가 반드시 언급한다 (validateDraft) */
export const SEVERE_THRESHOLD = 4;

/**
 * 탐지기별 최소 데이터 기간. 근거가 이보다 짧으면 리포트에서 "판정 보류(관찰 중)"로만 쓴다.
 * 값은 탐지기 기본 비교 창과 같은 크기: 용량 최근 21일, 셀 편차 최근 30일, 인버터 최근 7일,
 * 스택은 break-in 이후 추세 구간 200 h (탐지기 minTotal 15구간 × 운전 약 13 h).
 */
export const MIN_DATA_SPANS: Readonly<Record<string, DataSpan>> = {
  'ess.capacity_fade': { value: 21, unit: 'days' },
  'ess.cell_imbalance': { value: 30, unit: 'days' },
  'pv.inverter_peer': { value: 7, unit: 'days' },
  'el.voltage_rise': { value: 200, unit: 'op_hours' },
  'fc.voltage_decay': { value: 200, unit: 'op_hours' },
};

/** 근거가 덮는 데이터 기간. 탐지 창(windowStart~End) 또는 스택 운전시간 폭 */
export function dataSpanOf(detectorId: string, evidence: PackEvidence, window: { readonly start: number; readonly end: number }): DataSpan | null {
  const min = MIN_DATA_SPANS[detectorId];
  if (!min) return null;
  if (min.unit === 'op_hours') return evidence.kind === 'stack' && evidence.opHoursSpan !== null ? { value: evidence.opHoursSpan, unit: 'op_hours' } : null;
  if (evidence.kind === 'pv_peer') return { value: evidence.days, unit: 'days' };
  return { value: roundTo((window.end - window.start) / MS_PER_DAY, 1) ?? 0, unit: 'days' };
}

export function judgementOf(input: { readonly confidence: number; readonly detectionCount: number; readonly dataSpan: DataSpan | null; readonly minDataSpan: DataSpan | null }): Judgement {
  if (input.minDataSpan !== null && (input.dataSpan === null || input.dataSpan.value < input.minDataSpan.value)) return 'hold';
  return input.confidence >= CONFIRMED_CONFIDENCE && input.detectionCount >= CONFIRMED_DETECTIONS ? 'confirmed' : 'provisional';
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** 효과 크기를 탐지기별 "크다고 볼 크기"로 나눈 값 (1 ≈ 심각도 3~4 수준) */
function magnitudeOf(detectorId: string, value: number | null, evidence: PackEvidence): number {
  const v = Math.abs(value ?? 0);
  switch (detectorId) {
    case 'ess.capacity_fade':
      return v / 10;
    case 'ess.cell_imbalance':
      return v / 30;
    case 'pv.inverter_peer':
      return v / 5;
    case 'el.voltage_rise':
    case 'fc.voltage_decay':
      return v / 30;
    case 'dq.gap_flatline':
      return evidence.kind === 'dq' && evidence.worstCompletenessPct !== null ? (100 - evidence.worstCompletenessPct) / 10 : 0.3;
    default:
      return 0.5;
  }
}

/** 추정 영향 = 효과 크기 정규화(0.1~3) × 설비 중요도/3 (중요도 없으면 3) */
export function impactOf(detectorId: string, effectValue: number | null, evidence: PackEvidence, criticality: number | null): number {
  return roundTo(clamp(magnitudeOf(detectorId, effectValue, evidence), 0.1, 3) * ((criticality ?? 3) / 3), 4) ?? 0;
}

export function priorityOf(severity: number, confidence: number, impact: number): number {
  return roundTo(severity * confidence * impact, 4) ?? 0;
}

/** 우선순위 정렬: 심각도 내림차순 → 우선순위 내림차순 → id 오름차순 (숫자) */
export function byReportOrder(a: Pick<PackFinding, 'severity' | 'priority' | 'id'>, b: Pick<PackFinding, 'severity' | 'priority' | 'id'>): number {
  return b.severity - a.severity || b.priority - a.priority || Number(a.id) - Number(b.id);
}

/** 할 일: 판정 보류·데이터 품질을 뺀 발견사항 중 심각도×신뢰도×추정 영향 상위 TODO_LIMIT개, 플레이북 첫 권고 */
export function pickTodo(findings: readonly PackFinding[]): PackTodo[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.judgement !== 'hold' && finding.category !== 'data_quality')
    .sort((a, b) => b.finding.priority - a.finding.priority || Number(a.finding.id) - Number(b.finding.id))
    .slice(0, TODO_LIMIT)
    .map(({ finding, index }, rank) => ({ rank: rank + 1, findingId: finding.id, findingIndex: index, action: finding.playbook?.actions[0] ?? finding.detectorLabel }));
}
