'use client';

import { RefreshCw } from 'lucide-react';
import { useActionState } from 'react';
import { regenerateExplanationAction } from '@/app/(console)/desk/[findingId]/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 쉬운 요약을 한 번 더 만든다. 결과 문구는 폼 아래에 붙는다 */
export function RegenerateExplanation({ findingId }: Readonly<{ findingId: string }>) {
  const [state, action] = useActionState<ActionState, FormData>(regenerateExplanationAction, IDLE_STATE);
  return (
    <form action={action} className="flex min-w-0 flex-col items-end gap-2">
      <input type="hidden" name="findingId" value={findingId} />
      <SubmitButton variant="secondary" pendingText="만드는 중…">
        <RefreshCw aria-hidden="true" className="size-4" />
        다시 생성
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
