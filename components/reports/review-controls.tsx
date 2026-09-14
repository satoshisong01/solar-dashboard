'use client';

import { CircleCheck, CopyPlus } from 'lucide-react';
import { useActionState } from 'react';
import { approveReportAction, regenerateReportAction } from '@/app/(console)/reports/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 승인: 검증을 통과해야 누를 수 있다. 서버에서도 다시 검증한다 */
export function ApproveForm({ reportId, validationOk }: Readonly<{ reportId: string; validationOk: boolean }>) {
  const [state, action] = useActionState<ActionState<null>, FormData>(approveReportAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="reportId" value={reportId} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="승인 중…" disabled={!validationOk}>
          <CircleCheck aria-hidden="true" className="size-4" />
          승인
        </SubmitButton>
        <p className="text-xs text-muted">{validationOk ? '승인하면 편집할 수 없고, 포함한 발견사항은 리포트 반영으로 바뀝니다.' : '검증 문제를 모두 해결해야 승인할 수 있습니다.'}</p>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

/** 승인·대체된 리포트: 같은 사이트·기간·발견사항 선택으로 새 초안 */
export function RegenerateForm({ reportId }: Readonly<{ reportId: string }>) {
  const [state, action] = useActionState<ActionState<null>, FormData>(regenerateReportAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="reportId" value={reportId} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="만드는 중…" variant="secondary">
          <CopyPlus aria-hidden="true" className="size-4" />새 초안 만들기
        </SubmitButton>
        <p className="text-xs text-muted">최신 발견사항·KPI로 다시 만든 초안을 승인하면 이 리포트는 대체됨이 됩니다.</p>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
