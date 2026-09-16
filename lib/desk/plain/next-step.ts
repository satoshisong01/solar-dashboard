// 4) 지금 할 일 — 고장모드 플레이북의 첫 점검 항목 하나. 조치 목록 전체는 워크스페이스의 '원인 후보 판별'에 그대로 있다.
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import type { PlainFinding } from './types';

export function plainNextStep(finding: Pick<PlainFinding, 'failureMode'>): string | null {
  const playbook = finding.failureMode === null ? null : PLAYBOOKS[finding.failureMode];
  const first = playbook?.inspections[0] ?? playbook?.actions[0] ?? null;
  return first === null ? null : `${first}.`;
}
