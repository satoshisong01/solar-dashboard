'use client';

import { useId, useState } from 'react';
import { CONTROL_CLASS, echoed, fieldError } from '@/components/forms/controls';
import { OPERATING_CONDITION_CHANGE } from '@/lib/analysis/transition-rules';
import type { ActionState } from '@/lib/forms/action-state';
import { DEFAULT_SUPPRESS_DAYS, DISMISS_REASONS, MAX_SUPPRESS_DAYS } from '@/lib/desk/labels';
import { DISMISS_NOTE_MAX } from '@/lib/forms/limits';

function FieldError({ id, message }: Readonly<{ id: string; message: string | undefined }>) {
  return message ? (
    <p id={id} className="text-xs text-crit">
      {message}
    </p>
  ) : null;
}

/**
 * 기각 입력: 사유(필수) · 메모 · 억제 기간 · (운영 조건 변경일 때) 기준선 분할 이벤트와 발생 시점.
 * 설계 §4.1 "기각이 곧 학습": 운영 조건 변경 기각은 asset_event(resets_baseline)로 기준선을 나눈다.
 */
export function DismissFields<T>({ state }: Readonly<{ state: ActionState<T> }>) {
  const id = useId();
  const [reason, setReason] = useState(echoed(state, 'reason'));
  const [reset, setReset] = useState(echoed(state, 'resetBaseline') === 'on');
  const operatingChange = reason === OPERATING_CONDITION_CHANGE;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-col gap-1 text-xs font-medium text-ink-2">
          기각 사유 <span className="sr-only">(필수)</span>
          <select name="reason" required value={reason} onChange={(event) => setReason(event.target.value)} className={CONTROL_CLASS} aria-invalid={Boolean(fieldError(state, 'reason'))} aria-describedby={`${id}-reason`}>
            <option value="">사유를 고르세요</option>
            {DISMISS_REASONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <FieldError id={`${id}-reason`} message={fieldError(state, 'reason')} />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs font-medium text-ink-2">
          억제 기간 (일)
          <input type="number" name="suppressDays" min={0} max={MAX_SUPPRESS_DAYS} step={1} defaultValue={echoed(state, 'suppressDays', String(DEFAULT_SUPPRESS_DAYS))} className={CONTROL_CLASS} aria-describedby={`${id}-suppress`} />
          <FieldError id={`${id}-suppress`} message={fieldError(state, 'suppressDays')} />
        </label>
      </div>
      <p className="-mt-1 text-xs text-muted">억제 기간 동안에는 같은 문제를 다시 탐지해도 새 발견사항을 만들지 않습니다. 0이면 억제하지 않습니다.</p>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        <span>
          메모 {reason === '기타' ? <span className="text-crit">(필수)</span> : <span className="text-muted">(선택)</span>}
        </span>
        <textarea name="note" rows={2} maxLength={DISMISS_NOTE_MAX} defaultValue={echoed(state, 'note')} className={CONTROL_CLASS} aria-describedby={`${id}-note`} />
        <FieldError id={`${id}-note`} message={fieldError(state, 'note')} />
      </label>
      {operatingChange && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-rule p-3">
          <legend className="px-1 text-xs font-medium text-ink-2">기준선 재설정</legend>
          <label className="inline-flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" name="resetBaseline" checked={reset} onChange={(event) => setReset(event.target.checked)} className="mt-1 accent-accent" />
            <span>
              기준선 재설정 이벤트 만들기
              <span className="block text-xs text-muted">설비 이벤트(설정값 변경, 기준선 분할)를 기록합니다. 다음 분석부터 이 시점 이전 데이터는 기준선에 쓰지 않아 같은 오탐이 사라집니다.</span>
            </span>
          </label>
          {reset && (
            <label className="flex w-fit flex-col gap-1 text-xs font-medium text-ink-2">
              운영 조건이 바뀐 시점 (KST)
              <input type="datetime-local" name="baselineAt" required defaultValue={echoed(state, 'baselineAt')} className={CONTROL_CLASS} aria-describedby={`${id}-baseline`} />
              <FieldError id={`${id}-baseline`} message={fieldError(state, 'baselineAt') ?? fieldError(state, 'resetBaseline')} />
            </label>
          )}
        </fieldset>
      )}
    </div>
  );
}
