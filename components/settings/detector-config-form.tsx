'use client';

import { useActionState, useState } from 'react';
import { createDetectorConfigAction, type ConfigSaveData } from '@/app/(console)/settings/detectors/actions';
import { ActionMessage, fieldError, SubmitButton } from '@/components/forms/controls';
import { CONTROL_CLASS } from '@/components/ui/form-styles';
import { differsFromDefault, inputTextOf } from '@/lib/detector-config/history';
import { formatParamValue, paramInputName, paramNullName, type ParamField, type ScopeKind } from '@/lib/detector-config/types';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { AssetCombobox, type ComboAsset } from './asset-combobox';
import { CHECK_CLASS } from '@/components/ui/form-styles';

export interface ScopeOption {
  readonly kind: ScopeKind;
  readonly label: string;
}

export interface ActiveConfig {
  readonly version: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly referenceWindow: Readonly<{ startDay: string; endDay: string }> | null;
}

type Props = Readonly<{
  detectorId: string;
  fields: readonly ParamField[];
  scopeOptions: readonly ScopeOption[];
  classKey: string | null;
  assets: readonly ComboAsset[];
  /** 범위 문자열 → 활성 버전 (폼 초기값) */
  activeByScope: Readonly<Record<string, ActiveConfig>>;
}>;

const rangeText = (field: ParamField): string => (field.min === null && field.max === null ? '' : `${field.min ?? '−∞'} ~ ${field.max ?? '∞'}`);

function ParamInput({ field, initialText, initialNull, error }: Readonly<{ field: ParamField; initialText: string; initialNull: boolean; error?: string }>) {
  const [text, setText] = useState(initialText);
  const [isNull, setIsNull] = useState(initialNull);
  const changed = differsFromDefault(field, text, isNull);
  const inputId = `param-${field.key}`;
  const hintId = `${inputId}-hint`;
  const placeholder = `물려받음 (코드 기본값 ${formatParamValue(field.defaultValue)})`;
  const control =
    field.kind === 'boolean' || field.kind === 'choice' ? (
      <select id={inputId} name={paramInputName(field.key)} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={hintId} aria-invalid={Boolean(error)} className={CONTROL_CLASS}>
        <option value="">{placeholder}</option>
        {(field.kind === 'boolean' ? ['true', 'false'] : field.options).map((option) => (
          <option key={option} value={option}>
            {field.kind === 'boolean' ? formatParamValue(option === 'true') : option}
          </option>
        ))}
      </select>
    ) : (
      <input id={inputId} name={paramInputName(field.key)} type="text" inputMode="decimal" value={text} disabled={isNull} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-describedby={hintId} aria-invalid={Boolean(error)} className={CONTROL_CLASS} />
    );

  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-md border p-2.5 ${changed ? 'border-accent bg-hydrogen-fill/40' : 'border-rule'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <label htmlFor={inputId} className="text-xs font-medium text-ink-2">
          {field.label}
          {field.unit !== '' && <span className="font-normal text-muted"> [{field.unit}]</span>}
        </label>
        {changed && <span className="rounded border border-accent px-1 text-[11px] font-medium text-accent">기본값과 다름</span>}
      </div>
      {control}
      {field.nullable && (
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-2 max-lg:min-h-11">
          <input type="checkbox" name={paramNullName(field.key)} checked={isNull} onChange={(e) => setIsNull(e.target.checked)} className={CHECK_CLASS} />
          자동(비움)으로 저장
        </label>
      )}
      <p id={hintId} className="text-xs text-muted">
        <span className="font-mono">{field.key}</span> · 기본 {formatParamValue(field.defaultValue)}
        {rangeText(field) !== '' && ` · 범위 ${rangeText(field)}`} · {field.description}
      </p>
      {error && <p className="text-xs text-crit">{error}</p>}
    </div>
  );
}

/** 새 설정 버전 만들기. 범위를 바꾸면 그 범위의 활성 버전 값으로 채운다 (빈 칸 = 넓은 범위·코드 기본값을 물려받음) */
export function DetectorConfigForm({ detectorId, fields, scopeOptions, classKey, assets, activeByScope }: Props) {
  const [state, action] = useActionState<ActionState<ConfigSaveData>, FormData>(createDetectorConfigAction, IDLE_STATE);
  const echo = state.status === 'error' ? state.values : null;
  const [scopeKind, setScopeKind] = useState<ScopeKind>((echo?.scopeKind as ScopeKind | undefined) ?? 'default');
  const [assetId, setAssetId] = useState<number | null>(echo?.assetId ? Number(echo.assetId) : null);
  const scope = scopeKind === 'default' ? 'default' : scopeKind === 'class' ? `class:${classKey}` : assetId === null ? null : `asset:${assetId}`;
  const active = scope === null ? undefined : activeByScope[scope];
  // 오류 뒤 입력값은 같은 범위를 보고 있을 때만 다시 채운다 (범위를 바꾸면 그 범위 활성 버전 값)
  const values = echo !== null && echo.scopeKind === scopeKind && (scopeKind !== 'asset' || echo.assetId === String(assetId)) ? echo : null;
  const initialText = (key: string) => (values ? (values[paramInputName(key)] ?? '') : inputTextOf(active?.params[key]));
  const initialNull = (key: string) => (values ? values[paramNullName(key)] === 'on' : active !== undefined && Object.hasOwn(active.params, key) && active.params[key] === null);
  const formKey = `${state.seq}|${scope ?? 'none'}|${values ? 'echo' : 'active'}`;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="detectorId" value={detectorId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-ink-2">적용 범위</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {scopeOptions.map((option) => (
            <label key={option.kind} className="inline-flex items-center gap-1.5 text-sm text-ink max-lg:min-h-11">
              <input type="radio" name="scopeKind" value={option.kind} checked={scopeKind === option.kind} onChange={() => setScopeKind(option.kind)} className={CHECK_CLASS} />
              {option.label}
            </label>
          ))}
        </div>
        {fieldError(state, 'scopeKind') && <p className="text-xs text-crit">{fieldError(state, 'scopeKind')}</p>}
        {scopeKind === 'asset' && (
          <div className="max-w-xl">
            <AssetCombobox name="assetId" label={`설비 (${classKey ?? '—'})`} assets={assets} defaultAssetId={assetId} error={fieldError(state, 'assetId')} onSelect={setAssetId} />
          </div>
        )}
        <p className="text-xs text-muted">
          {scope === null ? '설비를 고르면 그 설비의 활성 버전 값으로 채웁니다.' : active ? `${scope} 활성 버전 ${active.version} 값으로 채웠습니다.` : `${scope}에 활성 버전이 없어 빈 칸(물려받음)으로 시작합니다.`} 좁은 범위가 이깁니다: 기본 &lt; 설비 종류 &lt; 설비.
        </p>
      </fieldset>

      <div key={formKey} className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {fields.map((field) => (
            <ParamInput key={field.key} field={field} initialText={initialText(field.key)} initialNull={initialNull(field.key)} error={fieldError(state, paramInputName(field.key))} />
          ))}
        </div>
        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="mb-1 text-xs font-medium text-ink-2">기준 창 (KST 날짜, 양 끝 포함 · 둘 다 비우면 없음)</legend>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            시작일
            <input type="date" name="refStart" defaultValue={values ? (values.refStart ?? '') : (active?.referenceWindow?.startDay ?? '')} aria-invalid={Boolean(fieldError(state, 'refStart'))} className={CONTROL_CLASS} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            끝일
            <input type="date" name="refEnd" defaultValue={values ? (values.refEnd ?? '') : (active?.referenceWindow?.endDay ?? '')} aria-invalid={Boolean(fieldError(state, 'refEnd'))} className={CONTROL_CLASS} />
          </label>
          {(fieldError(state, 'refStart') || fieldError(state, 'refEnd')) && <p className="w-full text-xs text-crit">{fieldError(state, 'refStart') ?? fieldError(state, 'refEnd')}</p>}
        </fieldset>
      </div>

      <p className="rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink-2">
        저장하면 이 범위의 새 버전을 만들고 이전 활성 버전을 끕니다. 변경은 다음 분석 실행부터 적용되며 기존 발견사항은 바뀌지 않습니다.
      </p>
      <div>
        <SubmitButton pendingText="저장 중…" disabled={scope === null}>
          새 버전 저장
        </SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
