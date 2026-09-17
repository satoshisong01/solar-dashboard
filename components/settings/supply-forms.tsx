'use client';

import { FileUp, LoaderCircle } from 'lucide-react';
import { startTransition, useActionState, useId, useState, type ChangeEvent } from 'react';
import { applyDeliveryCsvAction, previewDeliveryCsvAction, recordDeliveryAction, type DeliveryPreviewData, type DeliverySaveData } from '@/app/(console)/settings/supply/actions';
import { ActionMessage, buttonClass, CONTROL_CLASS, echoed, Field, fieldError, SelectField, SubmitButton, TextField } from '@/components/forms/controls';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { DeliveryFormSite } from '@/lib/data/h2-delivery';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { DELIVERY_NOTE_MAX, SUPPLIER_MAX, VEHICLE_NO_MAX } from '@/lib/forms/limits';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { DELIVERY_CSV_HEADER, DELIVERY_CSV_MAX_CHARS, DELIVERY_CSV_REQUIRED_COLUMNS, type DeliveryCsvResult } from '@/lib/h2delivery/delivery-csv';

const PREVIEW_ROWS = 20;

/** 반입 기록 직접 입력 한 건 (수량·일시·공급사는 필수, 차량번호·단가·금액·순도는 선택) */
export function DeliveryManualForm({ sites, defaultDeliveredAt }: Readonly<{ sites: readonly DeliveryFormSite[]; defaultDeliveredAt: string }>) {
  const [state, action] = useActionState<ActionState<DeliverySaveData>, FormData>(recordDeliveryAction, IDLE_STATE);
  const first = sites.find((s) => s.hasDeliveryAsset) ?? sites[0];
  return (
    <form key={state.seq} action={action} className="flex flex-col gap-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <SelectField label="사이트" name="siteId" defaultValue={echoed(state, 'siteId', String(first?.id ?? ''))} required error={fieldError(state, 'siteId')} hint="※ 표시는 반입 설비가 등록된 사이트입니다">
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
              {s.hasDeliveryAsset ? ' ※' : ''}
            </option>
          ))}
        </SelectField>
        <TextField label="하역 완료 일시 (KST)" name="deliveredAt" type="datetime-local" required defaultValue={echoed(state, 'deliveredAt', defaultDeliveredAt)} error={fieldError(state, 'deliveredAt')} hint="이 시각의 KST 날짜로 원장에 귀속됩니다" />
        <TextField label="공급사" name="supplier" required maxLength={SUPPLIER_MAX} defaultValue={echoed(state, 'supplier')} error={fieldError(state, 'supplier')} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="반입량 (kg)" name="massKg" inputMode="decimal" required defaultValue={echoed(state, 'massKg')} error={fieldError(state, 'massKg')} hint="전표 인수량" />
        <TextField label="차량·전표번호 (선택)" name="vehicleNo" maxLength={VEHICLE_NO_MAX} defaultValue={echoed(state, 'vehicleNo')} error={fieldError(state, 'vehicleNo')} />
        <TextField label="반환 잔량 heel (kg, 선택)" name="heelMassKg" inputMode="decimal" defaultValue={echoed(state, 'heelMassKg')} error={fieldError(state, 'heelMassKg')} />
        <TextField label="단가 (원/kg, 선택)" name="unitPriceKrw" inputMode="decimal" defaultValue={echoed(state, 'unitPriceKrw')} error={fieldError(state, 'unitPriceKrw')} />
        <TextField label="금액 (원, 선택)" name="amountKrw" inputMode="decimal" defaultValue={echoed(state, 'amountKrw')} error={fieldError(state, 'amountKrw')} />
        <TextField label="성적서 순도 (%, 선택)" name="purityPct" inputMode="decimal" defaultValue={echoed(state, 'purityPct')} error={fieldError(state, 'purityPct')} />
      </div>
      <Field label="메모 (선택)" error={fieldError(state, 'note')}>
        {({ id, describedBy, invalid }) => <textarea id={id} name="note" rows={2} maxLength={DELIVERY_NOTE_MAX} defaultValue={echoed(state, 'note')} aria-describedby={describedBy} aria-invalid={invalid} className={CONTROL_CLASS} />}
      </Field>
      <div>
        <SubmitButton pendingText="저장 중…">반입 기록 저장</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

function Preview({ fileName, result }: Readonly<{ fileName: string; result: DeliveryCsvResult }>) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">
        <span className="font-mono">{fileName}</span> · 데이터 행 {formatNumber(result.dataRows, 0)} · 가져올 행 {formatNumber(result.rows.length, 0)} ·{' '}
        <span className={result.errorCount > 0 ? 'font-medium text-crit' : 'text-ok'}>오류 {formatNumber(result.errorCount, 0)}건</span>
      </p>
      {result.errorCount > 0 && (
        <div role="alert" className="rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit">
          <p className="font-medium">오류가 있는 행을 고친 뒤 파일을 다시 고르세요. 오류가 한 행이라도 있으면 아무것도 가져오지 않습니다.</p>
          <ul className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto text-xs">
            {result.errors.map((error, index) => (
              <li key={`${error.line}-${index}`}>
                {error.line}행: {error.message}
              </li>
            ))}
            {result.errorCount > result.errors.length && <li>외 {result.errorCount - result.errors.length}건</li>}
          </ul>
        </div>
      )}
      {result.rows.length > 0 && (
        <TableScroll label="반입 기록 CSV 미리보기 표">
          <table className={TABLE_CLASS}>
            <caption className="pb-2 text-left text-xs text-muted">
              미리보기 (앞 {Math.min(PREVIEW_ROWS, result.rows.length)}행{result.errorCount > 0 ? ', 오류 없는 행만' : ''})
            </caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>행</th>
                <th scope="col" className={TH_CLASS}>사이트</th>
                <th scope="col" className={TH_CLASS}>하역 일시</th>
                <th scope="col" className={TH_CLASS}>공급사 · 차량</th>
                <th scope="col" className={`${TH_CLASS} text-right`}>반입량 (kg)</th>
                <th scope="col" className={`${TH_CLASS} text-right`}>단가 (원/kg)</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, PREVIEW_ROWS).map((row) => (
                <tr key={row.line}>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.line}</td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.siteCode}</td>
                  <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(row.deliveredAt)}</td>
                  <td className={TD_CLASS}>
                    {row.supplier}
                    {row.vehicleNo ? <span className="block font-mono text-xs text-muted">{row.vehicleNo}</span> : null}
                  </td>
                  <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.massKg, 2)}</td>
                  <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.unitPriceKrw === null ? '—' : formatNumber(row.unitPriceKrw, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

/** 반입 기록 CSV 가져오기: 파일 → 서버 미리보기(사이트·중복 대조) → 오류가 없을 때만 적용 */
export function DeliveryCsvImport() {
  const [previewState, preview, previewing] = useActionState<ActionState<DeliveryPreviewData>, FormData>(previewDeliveryCsvAction, IDLE_STATE);
  const [applyState, apply, applying] = useActionState<ActionState<DeliverySaveData>, FormData>(applyDeliveryCsvAction, IDLE_STATE);
  const [file, setFile] = useState<{ name: string; text: string; applySeq: number } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const inputId = useId();
  const applied = file !== null && applyState.status === 'success' && applyState.seq > file.applySeq;
  const result = previewState.status === 'success' ? previewState.data.result : null;
  const canApply = file !== null && !applied && !previewing && result !== null && result.errorCount === 0 && result.rows.length > 0;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    setReadError(null);
    setFile(null);
    if (!chosen) return;
    try {
      const text = await chosen.text();
      if (text.length > DELIVERY_CSV_MAX_CHARS) return setReadError(`파일이 너무 큽니다 (최대 ${DELIVERY_CSV_MAX_CHARS.toLocaleString('ko-KR')}자).`);
      setFile({ name: chosen.name, text, applySeq: applyState.seq });
      const formData = new FormData();
      formData.set('csv', text);
      startTransition(() => preview(formData));
    } catch {
      setReadError('파일을 읽지 못했습니다. UTF-8 CSV인지 확인하세요.');
    }
  }

  const submitApply = () => {
    if (!file) return;
    const formData = new FormData();
    formData.set('csv', file.text);
    startTransition(() => apply(formData));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-ink-2">
          CSV 파일 (UTF-8, 헤더 <span className="font-mono">{DELIVERY_CSV_HEADER.slice(0, DELIVERY_CSV_REQUIRED_COLUMNS).join(',')}</span>)
        </label>
        <input id={inputId} type="file" accept=".csv,text/csv" onChange={handleFile} className="text-sm text-ink-2 max-lg:min-h-11 file:mr-3 file:rounded-md file:border file:border-rule-strong file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-2 max-lg:file:min-h-11 hover:file:bg-sunken" />
        <p className="text-xs text-muted">
          뒤에 <span className="font-mono">{DELIVERY_CSV_HEADER.slice(DELIVERY_CSV_REQUIRED_COLUMNS).join(',')}</span> 을 순서대로 더 붙일 수 있습니다. delivered_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST). 예){' '}
          <span className="font-mono">GP-1,2026-09-10 14:30,○○가스,12가3456,318.4</span>
        </p>
      </div>
      {readError && (
        <p role="alert" className="text-sm text-crit">
          {readError}
        </p>
      )}
      {previewing && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
          <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          사이트·중복과 대조하는 중…
        </p>
      )}
      {file && !applied && !previewing && previewState.status === 'error' && <ActionMessage state={previewState} />}
      {file && !applied && !previewing && result && <Preview fileName={file.name} result={result} />}
      {file && !applied && (
        <div>
          <button type="button" onClick={submitApply} disabled={!canApply || applying} className={buttonClass('primary')}>
            {applying ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <FileUp aria-hidden="true" className="size-4" />}
            {applying ? '가져오는 중…' : `${formatNumber(result?.rows.length ?? 0, 0)}행 가져오기`}
          </button>
        </div>
      )}
      {(applied || applyState.status === 'error') && <ActionMessage state={applyState}>{applied && <span className="text-xs">다른 파일을 가져오려면 파일을 다시 고르세요.</span>}</ActionMessage>}
    </div>
  );
}
