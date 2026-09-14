'use client';

import { useActionState, useState } from 'react';
import { recordDirectActionAction, type DirectActionData } from '@/app/(console)/actions/actions';
import { ActionMessage, CONTROL_CLASS, echoed, Field, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import type { ActionFormOptions } from '@/lib/data/maintenance';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { ACTION_NOTE_MAX, ACTION_TYPE_MAX, PERFORMED_BY_MAX } from '@/lib/forms/limits';

type Props = Readonly<{ options: ActionFormOptions }>;

function EffectFields({ state, metrics }: Readonly<{ state: ActionState<DirectActionData>; metrics: ActionFormOptions['assets'][number]['metrics'] }>) {
  const [metric, setMetric] = useState(echoed(state, 'effectMetric'));
  const unit = metrics.find((m) => m.key === metric)?.unit ?? '';
  if (metrics.length === 0) return <p className="rounded-md border border-rule bg-sunken px-3 py-2 text-xs text-ink-2">이 설비 종류에는 조치 효과 자동 검증 지표가 없어 기대 효과 없이 기록합니다.</p>;
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-rule p-3">
      <legend className="px-1 text-xs font-medium text-ink-2">기대 효과 (선택 · 조치 효과 자동 검증)</legend>
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
            <SelectField label="기대 방향" name="direction" defaultValue={echoed(state, 'direction', 'decrease')} error={fieldError(state, 'direction')}>
              <option value="increase">증가</option>
              <option value="decrease">감소</option>
            </SelectField>
            <TextField label={`최소 변화량${unit ? ` (${unit})` : ''}`} name="minDelta" inputMode="decimal" required defaultValue={echoed(state, 'minDelta')} error={fieldError(state, 'minDelta')} hint="현장 판단 값" />
            <TextField label="안정화 일수" name="stabilizationDays" type="number" min={0} max={90} required defaultValue={echoed(state, 'stabilizationDays', '7')} error={fieldError(state, 'stabilizationDays')} />
          </>
        )}
      </div>
    </fieldset>
  );
}

/** 조치 직접 등록: 사이트 → 설비 → (선택) 같은 설비의 열린 발견사항. 발견사항을 연결하면 조치 완료로 바뀐다 */
export function DirectActionForm({ options }: Props) {
  const [state, action] = useActionState<ActionState<DirectActionData>, FormData>(recordDirectActionAction, IDLE_STATE);
  const [siteId, setSiteId] = useState(echoed(state, 'siteId', String(options.sites[0]?.id ?? '')));
  const [assetId, setAssetId] = useState(echoed(state, 'assetId'));
  const assets = options.assets.filter((a) => String(a.siteId) === siteId);
  const asset = assets.find((a) => String(a.id) === assetId) ?? null;
  const findings = options.findings.filter((f) => String(f.siteId) === siteId && (asset === null || f.assetId === asset.id));

  return (
    <form key={state.seq} action={action} className="flex flex-col gap-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <SelectField
          label="사이트"
          name="siteId"
          value={siteId}
          onChange={(event) => {
            setSiteId(event.target.value);
            setAssetId('');
          }}
          error={fieldError(state, 'siteId')}
        >
          {options.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="설비" name="assetId" value={assetId} onChange={(event) => setAssetId(event.target.value)} required error={fieldError(state, 'assetId')}>
          <option value="">설비를 고르세요</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.path} · {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="연결 발견사항 (선택)" name="findingId" defaultValue={echoed(state, 'findingId')} error={fieldError(state, 'findingId')} hint={asset === null ? '설비를 고르면 그 설비의 열린 발견사항만 보입니다' : undefined}>
          <option value="">연결 안 함 (정기 정비 등)</option>
          {findings.map((f) => (
            <option key={f.id} value={f.id}>
              #{f.id} {f.title}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <TextField label="조치 종류" name="actionType" required maxLength={ACTION_TYPE_MAX} defaultValue={echoed(state, 'actionType')} error={fieldError(state, 'actionType')} className="lg:col-span-2" />
        <TextField label="수행일시 (KST, 예정 가능)" name="performedAt" type="datetime-local" required defaultValue={echoed(state, 'performedAt')} error={fieldError(state, 'performedAt')} />
        <TextField label="수행자 (선택)" name="performedBy" maxLength={PERFORMED_BY_MAX} defaultValue={echoed(state, 'performedBy')} error={fieldError(state, 'performedBy')} />
      </div>
      <EffectFields key={assetId} state={state} metrics={asset?.metrics ?? []} />
      <Field label="메모 (선택)" error={fieldError(state, 'notes')}>
        {({ id, describedBy, invalid }) => <textarea id={id} name="notes" rows={2} maxLength={ACTION_NOTE_MAX} defaultValue={echoed(state, 'notes')} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} />}
      </Field>
      <div>
        <SubmitButton pendingText="등록 중…">조치 등록</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
