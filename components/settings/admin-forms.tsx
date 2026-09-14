'use client';

import { useActionState } from 'react';
import { createAdminAction, userAdminAction } from '@/app/(console)/settings/admins/actions';
import { ActionMessage, echoed, fieldError, SubmitButton, TextField } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { PASSWORD_MAX, PASSWORD_MIN } from '@/lib/forms/limits';

export function CreateAdminForm() {
  const [state, action] = useActionState<ActionState, FormData>(createAdminAction, IDLE_STATE);
  return (
    <form key={state.seq} action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        <TextField label="이메일" name="email" type="email" required autoComplete="off" defaultValue={echoed(state, 'email')} error={fieldError(state, 'email')} />
        <TextField label="이름" name="name" required maxLength={60} autoComplete="off" defaultValue={echoed(state, 'name')} error={fieldError(state, 'name')} />
        <TextField
          label="임시 비밀번호"
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          autoComplete="new-password"
          error={fieldError(state, 'password')}
          hint={`${PASSWORD_MIN}자 이상. 입력값은 다시 표시하지 않습니다.`}
        />
      </div>
      <div>
        <SubmitButton pendingText="만드는 중…">관리자 만들기</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

type UserActionsProps = Readonly<{ userId: string; label: string; banned: boolean; isSelf: boolean }>;

/** 계정 한 줄의 비활성·다시 활성·세션 폐기. 누른 버튼의 op 값으로 구분한다 */
export function UserActions({ userId, label, banned, isSelf }: UserActionsProps) {
  const [state, action] = useActionState<ActionState, FormData>(userAdminAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-1.5">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="userId" value={userId} />
        {banned ? (
          <SubmitButton name="op" value="unban" pendingText="처리 중…" variant="secondary">
            다시 활성<span className="sr-only"> — {label}</span>
          </SubmitButton>
        ) : (
          <SubmitButton name="op" value="ban" pendingText="처리 중…" variant="danger" disabled={isSelf}>
            비활성<span className="sr-only"> — {label}</span>
          </SubmitButton>
        )}
        <SubmitButton name="op" value="revoke" pendingText="처리 중…" variant="secondary">
          세션 폐기<span className="sr-only"> — {label}</span>
        </SubmitButton>
      </form>
      {isSelf && <p className="text-xs text-muted">내 계정은 비활성할 수 없습니다. 내 세션을 폐기하면 로그아웃됩니다.</p>}
      <ActionMessage state={state} />
    </div>
  );
}
