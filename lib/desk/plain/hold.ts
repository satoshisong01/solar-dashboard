// 판정 보류: 근거가 덮는 데이터 기간이 탐지기 최소 기간에 못 미치는 건.
// 최소 기간 표는 리포트 계획 규칙(lib/report/planner.ts MIN_DATA_SPANS)을 그대로 쓴다 — 화면과 리포트가 같은 건을 다르게 말하면 안 된다.
import { MS_PER_DAY } from '@/lib/analytics/types';
import { formatNumber } from '@/lib/format';
import { MIN_DATA_SPANS } from '@/lib/report/planner';
import type { EvidenceView } from '../evidence-types';
import { subjectText } from './common';
import type { PlainFinding, PlainSummary } from './types';

export interface HoldReason {
  /** 근거가 덮는 기간 */
  readonly span: number;
  readonly minSpan: number;
  readonly unit: 'days' | 'op_hours';
}

/** 스택 탐지기는 누적 운전시간 축이라 추세 점의 x 폭이 데이터 기간이다 */
function opHoursSpan(evidence: EvidenceView): number | null {
  if (evidence.kind !== 'stack' || evidence.trend === null || evidence.trend.xKind !== 'op_hours') return null;
  const xs = evidence.trend.points.map(([x]) => x);
  return xs.length === 0 ? null : Math.max(...xs) - Math.min(...xs);
}

/** 최소 데이터 기간에 못 미치면 사유, 아니면 null */
export function holdReasonOf(finding: PlainFinding, evidence: EvidenceView): HoldReason | null {
  const min = MIN_DATA_SPANS[finding.detectorId];
  if (min === undefined) return null;
  const span = min.unit === 'op_hours' ? opHoursSpan(evidence) : (finding.windowEndMs - finding.windowStartMs) / MS_PER_DAY;
  if (span === null || !Number.isFinite(span)) return null;
  return span < min.value ? { span, minSpan: min.value, unit: min.unit } : null;
}

/** '45일치' · '운전 180시간치' */
const spanText = (value: number, unit: HoldReason['unit']): string => (unit === 'days' ? `${formatNumber(value, 0)}일치` : `운전 ${formatNumber(value, 0)}시간치`);

/** 판정 보류 4줄: 효과 수치 대신 왜 이른지·언제 다시 보면 되는지만 쓴다 */
export function holdSummary(finding: PlainFinding, reason: HoldReason): PlainSummary {
  const subject = subjectText(finding);
  const remaining = Math.max(1, Math.ceil(reason.minSpan - reason.span));
  return {
    what: `아직 판단하기 이릅니다 — ${subject}의 데이터가 아직 ${spanText(reason.span, reason.unit)}뿐입니다.`,
    basis: `이 항목은 ${spanText(reason.minSpan, reason.unit)}는 모여야 조건이 비슷한 때끼리 견줄 수 있습니다.`,
    outlook: '지금 나온 숫자는 참고만 하세요. 데이터가 더 쌓이면 판정이 바뀔 수 있습니다.',
    nextStep: `${reason.unit === 'days' ? `${formatNumber(remaining, 0)}일` : `운전 ${formatNumber(remaining, 0)}시간`}쯤 더 쌓인 뒤 분석을 다시 실행하세요.`,
    hold: true,
  };
}
