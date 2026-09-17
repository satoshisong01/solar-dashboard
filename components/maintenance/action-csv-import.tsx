'use client';

import { FileUp, LoaderCircle } from 'lucide-react';
import { startTransition, useActionState, useId, useState, type ChangeEvent } from 'react';
import { applyActionCsvAction, previewActionCsvAction, type CsvPreviewData } from '@/app/(console)/actions/actions';
import { ActionMessage, buttonClass } from '@/components/forms/controls';
import { TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { ACTION_CSV_HEADER, ACTION_CSV_MAX_CHARS, type ActionCsvResult } from '@/lib/maintenance/action-csv';

const PREVIEW_ROWS = 20;

function Preview({ fileName, result }: Readonly<{ fileName: string; result: ActionCsvResult }>) {
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
        <TableScroll label="조치 CSV 미리보기 표">
          <table className={TABLE_CLASS}>
            <caption className="pb-2 text-left text-xs text-muted">미리보기 (앞 {Math.min(PREVIEW_ROWS, result.rows.length)}행{result.errorCount > 0 ? ', 오류 없는 행만' : ''})</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>행</th>
                <th scope="col" className={TH_CLASS}>설비</th>
                <th scope="col" className={TH_CLASS}>조치 유형</th>
                <th scope="col" className={TH_CLASS}>수행일시</th>
                <th scope="col" className={TH_CLASS}>발견사항</th>
                <th scope="col" className={TH_CLASS}>기대 효과</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, PREVIEW_ROWS).map((row) => (
                <tr key={row.line}>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.line}</td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.assetPath}</td>
                  <td className={TD_CLASS}>{row.actionType}</td>
                  <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(row.performedAt)}</td>
                  <td className={TD_CLASS}>{row.findingId ? `#${row.findingId}` : '—'}</td>
                  <td className={`${TD_CLASS} text-xs text-ink-2`}>{row.expectedEffect ? `${row.expectedEffect.metric} ${row.expectedEffect.direction === 'decrease' ? '감소' : '증가'} · 안정화 ${row.expectedEffect.stabilization_days}일` : '없음'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

/** 조치 CSV 가져오기: 파일 → 서버 미리보기(사이트·설비·발견사항·중복 대조, 행별 오류) → 오류가 없을 때만 적용 */
export function ActionCsvImport() {
  const [previewState, preview, previewing] = useActionState<ActionState<CsvPreviewData>, FormData>(previewActionCsvAction, IDLE_STATE);
  const [applyState, apply, applying] = useActionState<ActionState<CsvPreviewData>, FormData>(applyActionCsvAction, IDLE_STATE);
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
      if (text.length > ACTION_CSV_MAX_CHARS) return setReadError(`파일이 너무 큽니다 (최대 ${ACTION_CSV_MAX_CHARS.toLocaleString('ko-KR')}자).`);
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
          CSV 파일 (UTF-8, 헤더 <span className="font-mono">{ACTION_CSV_HEADER.join(',')}</span>, finding_id 열은 선택)
        </label>
        <input id={inputId} type="file" accept=".csv,text/csv" onChange={handleFile} className="text-sm text-ink-2 max-lg:min-h-11 file:mr-3 file:rounded-md file:border file:border-rule-strong file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-2 max-lg:file:min-h-11 hover:file:bg-sunken" />
        <p className="text-xs text-muted">
          performed_at: YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (KST). finding_id를 넣으면 그 탐지기의 기본 검증 지표로 기대 효과를 채우고(최소 변화량 0), 발견사항은 조치 완료로 바뀝니다. 예){' '}
          <span className="font-mono">SIM-A,SIM-A/ESS1/RACK03,셀 밸런싱,2026-08-01 09:30,현장팀,,2</span>
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
          사이트·설비·발견사항과 대조하는 중…
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
