'use client';

import { useActionState, useId, useState } from 'react';
import { recordMaintenanceAction, type ActionRecordData } from '@/app/(console)/desk/actions';
import { ActionMessage, CONTROL_CLASS, echoed, Field, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import type { ExpectedEffectDefaults, VerificationMetricOption } from '@/lib/desk/action-defaults';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { ACTION_NOTE_MAX, ACTION_TYPE_MAX, PERFORMED_BY_MAX } from '@/lib/forms/limits';

type ActionFormProps = Readonly<{
  findingId: string;
  suggestions: readonly string[];
  /** 이 설비 종류로 계산할 수 있는 검증 지표 (없으면 기대 효과 입력을 숨긴다) */
  metrics: readonly VerificationMetricOption[];
  defaults: ExpectedEffectDefaults | null;
}>;

function EffectFields({ state, metrics, defaults }: Readonly<{ state: ActionState<ActionRecordData>; metrics: readonly VerificationMetricOption[]; defaults: ExpectedEffectDefaults | null }>) {
  const [metric, setMetric] = useState(state.status === 'error' ? (state.values.effectMetric ?? '') : (defaults?.metric ?? ''));
  const unit = metrics.find((m) => m.key === metric)?.unit ?? '';
  if (metrics.length === 0) {
    return <p className="rounded-md border border-rule bg-sunken px-3 py-2 text-xs text-ink-2">이 설비 종류에는 조치 효과 자동 검증 지표가 없어 기대 효과 없이 기록합니다.</p>;
  }
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-rule p-3">
      <legend className="px-1 text-xs font-medium text-ink-2">기대 효과 (조치 효과 자동 검증)</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField label="검증 지표" name="effectMetric" value={metric} onChange={(event) => setMetric(event.target.value)} error={fieldError(state, 'effectMetric')}>
          <option value="">기대 효과 없음 (검증 안 함)</option>
          {metrics.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({m.unit})
            </option>
          ))}
        </SelectField>
        {metric !== '' && (
          <>
            <SelectField label="기대 방향" name="direction" defaultValue={echoed(state, 'direction', defaults?.metric === metric ? defaults.direction : 'increase')} error={fieldError(state, 'direction')}>
              <option value="increase">증가</option>
              <option value="decrease">감소</option>
            </SelectField>
            <TextField label={`최소 변화량${unit ? ` (${unit})` : ''}`} name="minDelta" inputMode="decimal" required defaultValue={echoed(state, 'minDelta')} error={fieldError(state, 'minDelta')} hint={defaults?.metric === metric ? defaults.levelHint : undefined} />
            <TextField label="안정화 일수" name="stabilizationDays" type="number" min={0} max={90} required defaultValue={echoed(state, 'stabilizationDays', String(defaults?.stabilizationDays ?? 7))} error={fieldError(state, 'stabilizationDays')} />
          </>
        )}
      </div>
      <p className="text-xs text-muted">조치 전 30일과 안정화 뒤 30일을 같은 조건으로 비교합니다. 비교 창이 채워진 뒤 분석을 실행하면 개선 여부를 판정하고, 개선이면 발견사항을 효과 확인으로 옮깁니다.</p>
    </fieldset>
  );
}

/** 권고 조치 작성 → om.maintenance_action. 수행일은 예정(미래)도 입력할 수 있다 */
export function ActionForm({ findingId, suggestions, metrics, defaults }: ActionFormProps) {
  const [state, action] = useActionState<ActionState<ActionRecordData>, FormData>(recordMaintenanceAction, IDLE_STATE);
  const listId = useId();

  return (
    <form key={state.seq} action={action} className="flex flex-col gap-4">
      <input type="hidden" name="findingId" value={findingId} />
      <div className="grid gap-3 lg:grid-cols-3">
        <TextField label="조치 종류" name="actionType" list={listId} required maxLength={ACTION_TYPE_MAX} defaultValue={echoed(state, 'actionType', suggestions[0] ?? '')} error={fieldError(state, 'actionType')} hint="플레이북 권고에서 고르거나 직접 입력" className="lg:col-span-2" />
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <TextField label="수행일시 (KST, 예정 가능)" name="performedAt" type="datetime-local" required defaultValue={echoed(state, 'performedAt')} error={fieldError(state, 'performedAt')} />
        <TextField label="수행자 (선택)" name="performedBy" maxLength={PERFORMED_BY_MAX} defaultValue={echoed(state, 'performedBy')} error={fieldError(state, 'performedBy')} />
      </div>
      <EffectFields state={state} metrics={metrics} defaults={defaults} />
      <Field label="메모 (선택)" error={fieldError(state, 'notes')}>
        {({ id, describedBy, invalid }) => <textarea id={id} name="notes" rows={2} maxLength={ACTION_NOTE_MAX} defaultValue={echoed(state, 'notes')} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} />}
      </Field>
      <div>
        <SubmitButton pendingText="기록 중…">조치 기록</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
