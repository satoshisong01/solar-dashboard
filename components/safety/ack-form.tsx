'use client';

import { useActionState, useId } from 'react';
import { ackSafetyEventAction } from '@/app/(console)/safety/actions';
import { ActionMessage, CONTROL_CLASS, echoed, fieldError, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 안전 이벤트 한 건의 확인(ack) 폼. 메모 없이는 확인할 수 없다 */
export function AckForm({ eventId, eventLabel }: Readonly<{ eventId: string; eventLabel: string }>) {
  const [state, action] = useActionState<ActionState, FormData>(ackSafetyEventAction, IDLE_STATE);
  const noteId = useId();
  const error = fieldError(state, 'note');

  return (
    <form key={state.seq} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="eventId" value={eventId} />
      <label htmlFor={noteId} className="text-xs font-medium text-ink-2">
        확인 메모 <span className="text-muted">(필수 · 조치 내용이나 판단 근거)</span>
      </label>
      <textarea
        id={noteId}
        name="note"
        rows={2}
        required
        maxLength={500}
        defaultValue={echoed(state, 'note')}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${noteId}-error` : undefined}
        className={CONTROL_CLASS}
      />
      {error && (
        <p id={`${noteId}-error`} className="text-xs text-crit">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingText="확인 중…" variant="danger">
          <span>
            확인(ack)<span className="sr-only"> — {eventLabel}</span>
          </span>
        </SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
