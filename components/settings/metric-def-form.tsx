'use client';

import { useActionState } from 'react';
import { createMetricDefAction, updateMetricDefAction } from '@/app/(console)/settings/catalog/actions';
import { ActionMessage, CONTROL_CLASS, Field, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { ROLLUP_KINDS, ROLLUP_LABELS, VALUE_KIND_LABELS, VALUE_KINDS } from '@/lib/forms/limits';

/** 폼 초기값 (문자열). 새 메트릭이면 빈 값 */
export interface MetricFormValues {
  readonly key: string;
  readonly nameKo: string;
  readonly quantity: string;
  readonly unit: string;
  readonly valueKind: string;
  readonly rollup: string;
  readonly hardMin: string;
  readonly hardMax: string;
  readonly expectedMin: string;
  readonly expectedMax: string;
  readonly flatlineMaxS: string;
  readonly aliases: string;
}

type MetricDefFormProps = Readonly<{ mode: 'create' | 'edit'; initial: MetricFormValues }>;

export function MetricDefForm({ mode, initial }: MetricDefFormProps) {
  const [state, action] = useActionState<ActionState, FormData>(mode === 'create' ? createMetricDefAction : updateMetricDefAction, IDLE_STATE);
  const value = (name: keyof MetricFormValues) => (state.status === 'error' ? (state.values[name] ?? '') : initial[name]);

  return (
    <form key={state.seq} action={action} className="flex flex-col gap-5">
      <fieldset className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-ink">기본</legend>
        {mode === 'create' ? (
          <TextField
            label="키"
            name="key"
            required
            maxLength={64}
            defaultValue={value('key')}
            error={fieldError(state, 'key')}
            placeholder="예: stack.temp.in"
            hint="도메인.물리량[.구분] — 영문 소문자·숫자와 점. 저장 후에는 바꿀 수 없습니다."
            autoComplete="off"
          />
        ) : (
          <Field label="키" hint="포인트가 참조하므로 바꿀 수 없습니다.">
            {({ id, describedBy }) => (
              <input id={id} name="key" readOnly value={initial.key} aria-describedby={describedBy} className={`${CONTROL_CLASS} bg-sunken font-mono`} />
            )}
          </Field>
        )}
        <TextField label="이름" name="nameKo" required maxLength={60} defaultValue={value('nameKo')} error={fieldError(state, 'nameKo')} placeholder="예: 스택 입구 온도" />
        <TextField label="물리량" name="quantity" required maxLength={40} defaultValue={value('quantity')} error={fieldError(state, 'quantity')} placeholder="예: temperature" autoComplete="off" />
        <TextField label="정규 단위" name="unit" maxLength={20} defaultValue={value('unit')} error={fieldError(state, 'unit')} placeholder="예: °C (무차원이면 비움)" hint="수집값은 포인트의 배율·오프셋으로 이 단위로 바꿔 저장합니다." />
        <SelectField label="값 종류" name="valueKind" required defaultValue={value('valueKind') || 'gauge'} error={fieldError(state, 'valueKind')}>
          {VALUE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{VALUE_KIND_LABELS[kind]}</option>
          ))}
        </SelectField>
        <SelectField label="롤업 대표값" name="rollup" required defaultValue={value('rollup') || 'avg'} error={fieldError(state, 'rollup')} hint="1시간 롤업에서 이 메트릭을 대표하는 통계">
          {ROLLUP_KINDS.map((kind) => (
            <option key={kind} value={kind}>{ROLLUP_LABELS[kind]}</option>
          ))}
        </SelectField>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold text-ink">범위 <span className="font-normal text-muted">(선택)</span></legend>
        <TextField label="물리 하한" name="hardMin" inputMode="decimal" defaultValue={value('hardMin')} error={fieldError(state, 'hardMin')} hint="밖이면 '범위 밖' 비트" />
        <TextField label="물리 상한" name="hardMax" inputMode="decimal" defaultValue={value('hardMax')} error={fieldError(state, 'hardMax')} />
        <TextField label="정상 하한" name="expectedMin" inputMode="decimal" defaultValue={value('expectedMin')} error={fieldError(state, 'expectedMin')} hint="정상 운전의 전형 범위" />
        <TextField label="정상 상한" name="expectedMax" inputMode="decimal" defaultValue={value('expectedMax')} error={fieldError(state, 'expectedMax')} />
        <TextField label="고착 판정 시간(초)" name="flatlineMaxS" inputMode="numeric" defaultValue={value('flatlineMaxS')} error={fieldError(state, 'flatlineMaxS')} hint="값이 이 시간 넘게 그대로면 고착 의심" />
      </fieldset>

      <Field label="별칭 (선택)" error={fieldError(state, 'aliases')} hint="벤더 태그·표준 모델 이름. 줄바꿈이나 쉼표로 구분, 20개까지">
        {({ id, describedBy, invalid }) => (
          <textarea id={id} name="aliases" rows={3} defaultValue={value('aliases')} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="저장 중…">{mode === 'create' ? '메트릭 추가' : '저장'}</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
