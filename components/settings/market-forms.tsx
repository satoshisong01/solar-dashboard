'use client';

import { FileUp } from 'lucide-react';
import { useActionState, useId, useState, type ChangeEvent } from 'react';
import { applyMarketCsvAction, saveMarketManualAction, type MarketSaveData } from '@/app/(console)/settings/market/actions';
import { ActionMessage, echoed, fieldError, SubmitButton, TextField } from '@/components/forms/controls';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatNumber } from '@/lib/format';
import { MARKET_KEYS, MARKET_LABELS, MARKET_UNITS } from '@/lib/market/keys';
import { MARKET_CSV_HEADER, MARKET_CSV_MAX_CHARS, parseMarketCsv, type MarketCsvResult } from '@/lib/market/market-csv';

const PREVIEW_ROWS = 20;

export function MarketManualForm({ defaultDay }: Readonly<{ defaultDay: string }>) {
  const [state, action] = useActionState<ActionState<MarketSaveData>, FormData>(saveMarketManualAction, IDLE_STATE);
  return (
    <form key={state.seq} action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label="날짜 (KST)" name="day" type="date" required defaultValue={echoed(state, 'day', defaultDay)} error={fieldError(state, 'day')} />
        {MARKET_KEYS.map((key) => (
          <TextField
            key={key}
            label={`${MARKET_LABELS[key]} (${MARKET_UNITS[key]})`}
            name={key}
            inputMode="decimal"
            defaultValue={echoed(state, key)}
            error={fieldError(state, key)}
            placeholder="비우면 저장 안 함"
          />
        ))}
      </div>
      <p className="text-xs text-muted">입력한 항목만 저장하고, 같은 날짜·항목이 있으면 덮어씁니다. 천 단위 쉼표 없이 숫자만 입력하세요.</p>
      <div>
        <SubmitButton pendingText="저장 중…">저장</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

interface CsvPreview {
  readonly fileName: string;
  readonly text: string;
  readonly result: MarketCsvResult;
  /** 파일을 고른 시점의 액션 seq. 이후 적용에 성공하면 미리보기를 닫는다 */
  readonly seq: number;
}

function PreviewSummary({ preview }: Readonly<{ preview: CsvPreview }>) {
  const { result } = preview;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">
        <span className="font-mono">{preview.fileName}</span> · 데이터 행 {formatNumber(result.dataRows, 0)} · 적용할 행 {formatNumber(result.rows.length, 0)} ·{' '}
        <span className={result.errorCount > 0 ? 'font-medium text-crit' : 'text-ok'}>오류 {formatNumber(result.errorCount, 0)}건</span>
      </p>
      {result.errorCount > 0 && (
        <div role="alert" className="rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit">
          <p className="font-medium">오류가 있는 행을 고친 뒤 파일을 다시 고르세요. 오류가 있으면 아무 행도 저장하지 않습니다.</p>
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
        <TableScroll label="CSV 미리보기 표">
          <table className={TABLE_CLASS}>
            <caption className="pb-2 text-left text-xs text-muted">
              미리보기 (앞 {Math.min(PREVIEW_ROWS, result.rows.length)}행{result.errorCount > 0 ? ', 오류 없는 행만' : ''})
            </caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>날짜</th>
                <th scope="col" className={TH_CLASS}>항목</th>
                <th scope="col" className={`${TH_CLASS} text-right`}>값</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, PREVIEW_ROWS).map((row) => (
                <tr key={`${row.day}|${row.marketKey}`}>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.day}</td>
                  <td className={TD_CLASS}>{MARKET_LABELS[row.marketKey]}</td>
                  <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                    {formatNumber(row.value, 4)} <span className="text-xs text-muted">{MARKET_UNITS[row.marketKey]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

/** CSV 파일을 브라우저에서 읽어 같은 검증 규칙으로 미리보기 → 오류가 없을 때만 적용(서버에서 다시 검증) */
export function MarketCsvUpload() {
  const [state, action] = useActionState<ActionState<MarketSaveData>, FormData>(applyMarketCsvAction, IDLE_STATE);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const inputId = useId();
  const applied = preview !== null && state.status === 'success' && state.seq > preview.seq;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setReadError(null);
    setPreview(null);
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > MARKET_CSV_MAX_CHARS) return setReadError(`파일이 너무 큽니다 (최대 ${MARKET_CSV_MAX_CHARS.toLocaleString('ko-KR')}자).`);
      setPreview({ fileName: file.name, text, result: parseMarketCsv(text), seq: state.seq });
    } catch {
      setReadError('파일을 읽지 못했습니다. UTF-8 CSV인지 확인하세요.');
    }
  }

  const canApply = preview !== null && !applied && preview.result.errorCount === 0 && preview.result.rows.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-ink-2">
          CSV 파일 (UTF-8, 헤더 <span className="font-mono">{MARKET_CSV_HEADER.join(',')}</span>)
        </label>
        <input id={inputId} type="file" accept=".csv,text/csv" onChange={handleFile} className="text-sm text-ink-2 max-lg:min-h-11 file:mr-3 file:rounded-md file:border file:border-rule-strong file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-2 max-lg:file:min-h-11 hover:file:bg-sunken" />
        <p className="text-xs text-muted">
          market_key: {MARKET_KEYS.join(', ')} · day: YYYY-MM-DD · value: 숫자. 예) <span className="font-mono">2026-09-14,smp_land,142.35</span>
        </p>
      </div>
      {readError && (
        <p role="alert" className="text-sm text-crit">
          {readError}
        </p>
      )}
      {preview && !applied && <PreviewSummary preview={preview} />}
      {preview && !applied && (
        <form action={action}>
          <input type="hidden" name="csv" value={preview.text} />
          <SubmitButton pendingText="적용 중…" disabled={!canApply}>
            <FileUp aria-hidden="true" className="size-4" />
            {formatNumber(preview.result.rows.length, 0)}행 적용
          </SubmitButton>
        </form>
      )}
      <ActionMessage state={state}>{applied && <span className="text-xs">다른 파일을 올리려면 파일을 다시 고르세요.</span>}</ActionMessage>
    </div>
  );
}
