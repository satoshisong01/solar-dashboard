'use client';

import { useActionState, useState } from 'react';
import { dismissFindingsAction, reopenFindingAction, triageFindingsAction, type BulkResultData } from '@/app/(console)/desk/actions';
import { ActionMessage, buttonClass, SubmitButton } from '@/components/forms/controls';
import { checkTransition, type FindingStatus } from '@/lib/analysis/transition-rules';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { DismissFields } from './dismiss-fields';

/** 관리자 동작 가능 여부만 본다 (행위자 이름은 시스템이 아니면 무엇이든 같다) */
const can = (action: 'triage' | 'dismiss' | 'reopen', status: FindingStatus): boolean => checkTransition(action, status, 'admin', action === 'dismiss' ? '확인' : null).ok;

type Props = Readonly<{ findingId: string; status: FindingStatus }>;

/** 상태 전이 버튼: 분류(조사 중) · 기각(사유 필수) · 다시 열기. 리포트 반영은 리포트 승인, 조치 완료는 조치 기록, 효과 확인은 시스템이 한다 */
export function TransitionControls({ findingId, status }: Props) {
  const [triageState, triage] = useActionState<ActionState<BulkResultData>, FormData>(triageFindingsAction, IDLE_STATE);
  const [dismissState, dismiss] = useActionState<ActionState<BulkResultData>, FormData>(dismissFindingsAction, IDLE_STATE);
  const [reopenState, reopen] = useActionState<ActionState<BulkResultData>, FormData>(reopenFindingAction, IDLE_STATE);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [last, setLast] = useState<'triage' | 'dismiss' | 'reopen'>('triage');
  const withLast = (key: typeof last, dispatch: (formData: FormData) => void) => (formData: FormData) => {
    setLast(key);
    dispatch(formData);
  };
  const latest = { triage: triageState, dismiss: dismissState, reopen: reopenState }[last];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {can('triage', status) && (
          <form action={withLast('triage', triage)}>
            <input type="hidden" name="findingId" value={findingId} />
            <SubmitButton pendingText="분류 중…" variant="secondary">
              분류 (조사 중)
            </SubmitButton>
          </form>
        )}
        {can('dismiss', status) && (
          <button type="button" aria-expanded={dismissOpen} onClick={() => setDismissOpen((open) => !open)} className={buttonClass('danger')}>
            기각…
          </button>
        )}
        {can('reopen', status) && (
          <form action={withLast('reopen', reopen)}>
            <input type="hidden" name="findingId" value={findingId} />
            <SubmitButton pendingText="여는 중…" variant="secondary">
              다시 열기
            </SubmitButton>
          </form>
        )}
      </div>
      {dismissOpen && can('dismiss', status) && (
        <form key={dismissState.seq} action={withLast('dismiss', dismiss)} className="flex flex-col gap-3 rounded-md border border-crit/30 p-3">
          <input type="hidden" name="findingId" value={findingId} />
          <DismissFields state={dismissState} />
          <div>
            <SubmitButton pendingText="기각 중…" variant="danger">
              기각
            </SubmitButton>
          </div>
        </form>
      )}
      <ActionMessage state={latest} />
    </div>
  );
}
