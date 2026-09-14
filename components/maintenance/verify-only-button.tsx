'use client';

import { FlaskConical } from 'lucide-react';
import { useActionState } from 'react';
import { verifyOnlyAction, type VerifyOnlyData } from '@/app/(console)/actions/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 설비 단위 "검증만 실행": 분석 단계 없이 저장된 에피소드로 이 조치의 전후 비교만 다시 계산한다 */
export function VerifyOnlyButton({ actionId, compact = false }: Readonly<{ actionId: string; compact?: boolean }>) {
  const [state, action] = useActionState<ActionState<VerifyOnlyData>, FormData>(verifyOnlyAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="actionId" value={actionId} />
      <div>
        <SubmitButton pendingText="검증 중…" variant="secondary">
          <FlaskConical aria-hidden="true" className="size-4" />
          검증만 실행
        </SubmitButton>
      </div>
      {!compact || state.status !== 'idle' ? <ActionMessage state={state} /> : null}
    </form>
  );
}
