// 발견사항 쉬운 말 요약 (순수, 서버·클라이언트 공용).
//   1) 무엇이 어떻게 됐는지  2) 왜 믿을 만한지  3) 왜 문제인지·언제까지 괜찮은지  4) 지금 할 일
// 수치와 판정은 분석 엔진 값(finding.effect · 근거 스냅샷)을 그대로 쓰고 표현만 바꾼다.
import type { EvidenceView } from '../evidence-types';
import { plainBasis } from './basis';
import { plainHeadline } from './headline';
import { holdReasonOf, holdSummary } from './hold';
import { plainNextStep } from './next-step';
import { plainOutlook } from './outlook';
import type { PlainFinding, PlainSummary } from './types';

export function plainSummary(finding: PlainFinding, evidence: EvidenceView): PlainSummary {
  const hold = holdReasonOf(finding, evidence);
  if (hold !== null) return holdSummary(finding, hold);
  return {
    what: plainHeadline(finding),
    basis: plainBasis(evidence),
    outlook: plainOutlook(finding, evidence),
    nextStep: plainNextStep(finding),
    hold: false,
  };
}

export { assetCodeOf, severityAction, subjectText } from './common';
export { PLAIN_HEADLINE_DETECTORS, plainHeadline } from './headline';
export { holdReasonOf } from './hold';
export type { PlainFinding, PlainHeadlineInput, PlainSubject, PlainSummary } from './types';
