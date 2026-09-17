'use client';

import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { buttonClass, CHECK_CLASS, CONTROL_CLASS, type ButtonVariant } from '@/components/ui/form-styles';
import type { ActionState } from '@/lib/forms/action-state';

export { buttonClass, CHECK_CLASS, CONTROL_CLASS, type ButtonVariant };

type FieldProps = Readonly<{
  label: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: (ids: Readonly<{ id: string; describedBy: string | undefined; invalid: boolean }>) => ReactNode;
}>;

/** 라벨·도움말·오류를 입력과 연결한다 (aria-describedby, aria-invalid) */
export function Field({ label, error, hint, className = '', children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

type TextFieldProps = Omit<ComponentProps<'input'>, 'id' | 'className'> &
  Readonly<{ label: string; name: string; error?: string; hint?: ReactNode; className?: string }>;

export function TextField({ label, error, hint, className, ...input }: TextFieldProps) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      {({ id, describedBy, invalid }) => <input id={id} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} {...input} />}
    </Field>
  );
}

type SelectFieldProps = Omit<ComponentProps<'select'>, 'id' | 'className'> &
  Readonly<{ label: string; name: string; error?: string; hint?: ReactNode; className?: string }>;

export function SelectField({ label, error, hint, className, children, ...select }: SelectFieldProps) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      {({ id, describedBy, invalid }) => (
        <select id={id} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

type SubmitButtonProps = Readonly<{ children: ReactNode; pendingText: string; variant?: ButtonVariant; disabled?: boolean; name?: string; value?: string }>;

/** 폼 제출 중에는 비활성하고 진행 문구를 보여 준다 */
export function SubmitButton({ children, pendingText, variant = 'primary', disabled = false, name, value }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} className={buttonClass(variant)}>
      {pending && <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />}
      {pending ? pendingText : children}
    </button>
  );
}

/** 액션 결과 문구. 오류는 role=alert, 성공은 role=status */
export function ActionMessage<T>({ state, children }: Readonly<{ state: ActionState<T>; children?: ReactNode }>) {
  if (state.status === 'idle') return null;
  if (state.status === 'error') {
    const formError = state.fieldErrors[''];
    return (
      <p role="alert" className="flex items-start gap-2 rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          {state.message}
          {formError && <span className="block">{formError}</span>}
        </span>
      </p>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-ok/40 bg-ok-fill px-3 py-2 text-sm text-ok">
      <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <span>{state.message}</span>
        {children}
      </div>
    </div>
  );
}

/** 오류 상태일 때 사용자가 입력했던 값 (다시 채우기) */
export function echoed<T>(state: ActionState<T>, name: string, fallback = ''): string {
  return state.status === 'error' ? (state.values[name] ?? fallback) : fallback;
}

export function fieldError<T>(state: ActionState<T>, name: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors[name] : undefined;
}
