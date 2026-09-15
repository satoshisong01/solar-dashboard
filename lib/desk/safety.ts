// 안전 발견사항 규칙 (순수, 서버·클라이언트 공용). 설계 §5.3: 안전 카테고리는 severity ≥ 4 고정.
// 안전 발견사항은 오늘 화면 배너·플릿 위험·리포트 요약 맨 앞 '즉시 확인 필요' 블록에 따로 올린다 (수집 즉시 경로의 안전 이벤트와는 구분).
import { SAFETY_DISCLAIMER } from '@/lib/analytics/detectors/check-helpers';

export const SAFETY_FINDING_MIN_SEVERITY = 4;

/** 안전 관련 화면·문장에 붙이는 고정 원칙 */
export const SAFETY_FINDING_NOTICE = SAFETY_DISCLAIMER;

/** 안전 발견사항: 카테고리 safety이고 심각도 4 이상 */
export function isSafetyFinding(finding: { readonly category: string; readonly severity: number }): boolean {
  return finding.category === 'safety' && finding.severity >= SAFETY_FINDING_MIN_SEVERITY;
}
