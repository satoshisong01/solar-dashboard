'use client';

import { RefreshCw } from 'lucide-react';
import { useActionState } from 'react';
import { regenerateDigestAction } from '@/app/(console)/desk/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 종합 요약을 한 번 더 만든다. 지금 보고 있는 범위(사이트 필터)를 그대로 넘긴다 */
export function RegenerateDigest({ site }: Readonly<{ site: string | null }>) {
  const [state, action] = useActionState<ActionState, FormData>(regenerateDigestAction, IDLE_STATE);
  return (
    <form action={action} className="flex min-w-0 flex-col items-end gap-2">
      {site !== null && <input type="hidden" name="site" value={site} />}
      <SubmitButton variant="secondary" pendingText="만드는 중…">
        <RefreshCw aria-hidden="true" className="size-4" />
        다시 생성
      </SubmitButton>
      <ActionMessage state={state} />
    </form>
  );
}
