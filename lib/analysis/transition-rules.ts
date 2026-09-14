// finding 상태 전이 규칙 (순수). DB 서비스(transitions.ts)와 분석 실행기(findings.ts)가 같은 규칙으로 판단한다.
//   new ─triage→ triaged ─리포트 승인→ in_report ─조치 등록→ action_taken ─효과 확인(system)→ verified
//   열린 상태 어디서나 dismiss(사유 필수), 닫힌 상태(dismissed·verified)는 reopen, 조치 뒤 악화는 system이 reopened로 되돌린다.

export const FINDING_STATUSES = ['new', 'triaged', 'in_report', 'action_taken', 'verified', 'dismissed', 'reopened'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const CLOSED_STATUSES: readonly FindingStatus[] = ['verified', 'dismissed'];
export const SYSTEM_ACTOR = 'system';
/** 기각 사유 중 기준선 분할(asset_event.resets_baseline)을 함께 제안하는 사유 */
export const OPERATING_CONDITION_CHANGE = '운영 조건 변경';

export type TransitionAction = 'triage' | 'dismiss' | 'reopen' | 'report' | 'action' | 'verify' | 'worsen';

const ALLOWED: Readonly<Record<TransitionAction, { readonly from: readonly FindingStatus[]; readonly to: FindingStatus; readonly systemOnly: boolean }>> = {
  triage: { from: ['new', 'reopened'], to: 'triaged', systemOnly: false },
  dismiss: { from: ['new', 'triaged', 'in_report', 'action_taken', 'reopened'], to: 'dismissed', systemOnly: false },
  reopen: { from: ['dismissed', 'verified'], to: 'reopened', systemOnly: false },
  report: { from: ['new', 'triaged', 'reopened'], to: 'in_report', systemOnly: false },
  action: { from: ['new', 'triaged', 'in_report', 'reopened'], to: 'action_taken', systemOnly: false },
  verify: { from: ['action_taken'], to: 'verified', systemOnly: true },
  worsen: { from: ['triaged', 'in_report', 'action_taken'], to: 'reopened', systemOnly: true },
};

export const isFindingStatus = (value: string): value is FindingStatus => (FINDING_STATUSES as readonly string[]).includes(value);
export const isOpenStatus = (status: FindingStatus): boolean => !CLOSED_STATUSES.includes(status);

export type TransitionCheck = { readonly ok: true; readonly to: FindingStatus } | { readonly ok: false; readonly reason: string };

const LABELS: Readonly<Record<FindingStatus, string>> = {
  new: '새 발견',
  triaged: '분류됨',
  in_report: '리포트 반영',
  action_taken: '조치 완료',
  verified: '효과 확인',
  dismissed: '기각',
  reopened: '다시 열림',
};

export function statusLabel(status: FindingStatus): string {
  return LABELS[status];
}

/** 이 동작을 이 상태·행위자에서 할 수 있는지. 기각은 사유(공백 제외)가 필요하다 */
export function checkTransition(action: TransitionAction, from: FindingStatus, actor: string, reason?: string | null): TransitionCheck {
  const rule = ALLOWED[action];
  if (rule.systemOnly && actor !== SYSTEM_ACTOR) return { ok: false, reason: `${statusLabel(rule.to)} 전이는 시스템만 기록할 수 있습니다` };
  if (!rule.systemOnly && actor === SYSTEM_ACTOR) return { ok: false, reason: '관리자 동작은 관리자 계정으로 기록해야 합니다' };
  if (!rule.from.includes(from)) return { ok: false, reason: `${statusLabel(from)} 상태에서는 ${statusLabel(rule.to)}(으)로 바꿀 수 없습니다` };
  if (action === 'dismiss' && (reason ?? '').trim() === '') return { ok: false, reason: '기각 사유를 입력하세요' };
  return { ok: true, to: rule.to };
}
