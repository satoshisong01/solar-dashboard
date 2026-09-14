'use client';

import { Copy, KeyRound } from 'lucide-react';
import { useActionState, useState } from 'react';
import { createGatewayAction, issueGatewayKeyAction, revokeGatewayKeyAction, type IssuedKeyData } from '@/app/(console)/settings/gateways/actions';
import { ActionMessage, buttonClass, echoed, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

export function CreateGatewayForm({ sites }: Readonly<{ sites: readonly Readonly<{ id: number; code: string; name: string }>[] }>) {
  const [state, action] = useActionState<ActionState, FormData>(createGatewayAction, IDLE_STATE);
  return (
    <form key={state.seq} action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
        <SelectField label="사이트" name="siteId" required defaultValue={echoed(state, 'siteId')} error={fieldError(state, 'siteId')}>
          <option value="">사이트를 고르세요</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.code} · {site.name}
            </option>
          ))}
        </SelectField>
        <TextField label="게이트웨이 코드" name="code" required maxLength={64} defaultValue={echoed(state, 'code')} error={fieldError(state, 'code')} placeholder="예: GW-SIMB-02" hint="영문 대문자·숫자·하이픈, 봉투의 gateway 값" autoComplete="off" />
        <div className="sm:pt-5">
          <SubmitButton pendingText="만드는 중…">게이트웨이 만들기</SubmitButton>
        </div>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function IssuedSecret({ data }: Readonly<{ data: IssuedKeyData }>) {
  const [copy, setCopy] = useState<CopyState>('idle');
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(data.secret);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border-2 border-warn bg-warn-fill p-3 text-sm text-ink">
      <p className="font-semibold">비밀값은 지금 한 번만 표시됩니다.</p>
      <dl className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
        <dt className="text-xs text-ink-2">키 ID (X-OM-Key-Id)</dt>
        <dd className="font-mono break-all">{data.keyId}</dd>
        <dt className="text-xs text-ink-2">비밀값</dt>
        <dd className="font-mono break-all select-all">{data.secret}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={copySecret} className={buttonClass('secondary')}>
          <Copy aria-hidden="true" className="size-4" />
          비밀값 복사
        </button>
        <span role="status" className="text-xs text-ink-2">
          {copy === 'copied' ? '복사했습니다' : copy === 'failed' ? '복사하지 못했습니다. 값을 직접 선택해 복사하세요' : ''}
        </span>
      </div>
      <p className="text-xs text-ink-2">
        게이트웨이 설정에 키 ID와 함께 입력하거나 안전한 곳(비밀 관리 도구)에 보관하세요. 이 화면을 벗어나면 다시 볼 수 없고, DB에는 암호문만 남습니다. 잃어버리면 새 키를 발급하고 이 키를 폐기하세요.
      </p>
    </div>
  );
}

/** 새로고침 전까지 발급 결과(비밀값)를 보여 주도록 게이트웨이 행마다 항상 렌더한다 (활성 키가 가득 차도 버튼만 비활성) */
export function IssueKeyForm({ gatewayId, canIssue }: Readonly<{ gatewayId: number; canIssue: boolean }>) {
  const [state, action] = useActionState<ActionState<IssuedKeyData>, FormData>(issueGatewayKeyAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="gatewayId" value={gatewayId} />
        <SubmitButton pendingText="발급 중…" variant="secondary" disabled={!canIssue}>
          <KeyRound aria-hidden="true" className="size-4" />새 키 발급
        </SubmitButton>
        {!canIssue && <span className="text-xs text-muted">활성 키가 가득 찼습니다 — 하나를 폐기해야 발급할 수 있습니다</span>}
      </form>
      {state.status === 'error' && <ActionMessage state={state} />}
      {state.status === 'success' && <IssuedSecret data={state.data} />}
    </div>
  );
}

/** 폐기는 되돌릴 수 없으므로 한 번 더 확인한다 */
export function RevokeKeyForm({ keyId }: Readonly<{ keyId: string }>) {
  const [state, action] = useActionState<ActionState, FormData>(revokeGatewayKeyAction, IDLE_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" onClick={() => setConfirming(true)} className={buttonClass('danger')}>
          폐기<span className="sr-only"> — {keyId}</span>
        </button>
        {state.status === 'error' && <ActionMessage state={state} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="keyId" value={keyId} />
        <span className="text-xs text-crit">이 키로 오는 수집이 바로 거부됩니다.</span>
        <SubmitButton pendingText="폐기 중…" variant="danger">
          폐기 확인
        </SubmitButton>
        <button type="button" onClick={() => setConfirming(false)} className={buttonClass('secondary')}>
          취소
        </button>
      </form>
      {state.status === 'error' && <ActionMessage state={state} />}
    </div>
  );
}
