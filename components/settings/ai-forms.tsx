'use client';

import { useActionState } from 'react';
import { setGlobalAiAction, setSiteAiAction } from '@/app/(console)/settings/ai/actions';
import { ActionMessage, SelectField, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 전역 기본값. 설정한 적이 없으면 키 유무로 정해진 현재 값을 미리 고른다 */
export function AiGlobalForm({ current }: Readonly<{ current: boolean }>) {
  const [state, action] = useActionState<ActionState, FormData>(setGlobalAiAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label="전역 기본값" name="enabled" defaultValue={current ? 'on' : 'off'} className="w-44">
          <option value="on">사용</option>
          <option value="off">사용 안 함</option>
        </SelectField>
        <SubmitButton pendingText="저장 중…">저장</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

type SiteRow = Readonly<{ id: number; code: string; name: string; choice: 'on' | 'off' | 'inherit' }>;

export function AiSiteForm({ site }: Readonly<{ site: SiteRow }>) {
  const [state, action] = useActionState<ActionState, FormData>(setSiteAiAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="siteId" value={site.id} />
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label={`${site.name} (${site.code})`} name="enabled" defaultValue={site.choice} className="w-44">
          <option value="inherit">전역 따름</option>
          <option value="on">사용</option>
          <option value="off">사용 안 함</option>
        </SelectField>
        <SubmitButton variant="secondary" pendingText="저장 중…">저장</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
