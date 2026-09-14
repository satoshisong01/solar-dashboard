'use client';

import { Repeat } from 'lucide-react';
import Link from 'next/link';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { dismissFindingsAction, triageFindingsAction, type BulkResultData } from '@/app/(console)/desk/actions';
import { ActionMessage, buttonClass } from '@/components/forms/controls';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { formatEffectCi, formatEffectValue } from '@/lib/desk/effect';
import type { InboxRow } from '@/lib/desk/inbox';
import { CATEGORY_LABELS, detectorLabel } from '@/lib/desk/labels';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime } from '@/lib/format';
import { DismissFields } from './dismiss-fields';
import { ConfidenceBar, FindingSeverityChip, FindingStatusBadge } from './finding-badges';

type BulkAction = (formData: FormData) => void;

function BulkResult({ data }: Readonly<{ data: BulkResultData }>) {
  if (data.skipped.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {data.skipped.slice(0, 10).map((item) => (
        <li key={item.findingId}>
          #{item.findingId}: {item.reason}
        </li>
      ))}
    </ul>
  );
}

function FindingCells({ row }: Readonly<{ row: InboxRow }>) {
  const ci = formatEffectCi(row.effect);
  return (
    <>
      <td className={TD_CLASS}>
        <FindingSeverityChip severity={row.severity} />
        <span className="mt-1 block">
          <ConfidenceBar confidence={row.confidence} />
        </span>
      </td>
      <td className={`${TD_CLASS} min-w-64`}>
        <Link href={`/desk/${row.id}`} className="font-medium text-ink hover:underline">
          {row.title}
        </Link>
        <span className="block text-xs text-ink-2">
          {row.siteCode}
          {row.assetPath ? ` · ${row.assetPath.replace(`${row.siteCode}/`, '')}` : ' · 사이트 단위'} · {detectorLabel(row.detectorId)} · {CATEGORY_LABELS[row.category]}
        </span>
        {row.previousFindingId && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-warn">
            <Repeat aria-hidden="true" className="size-3" />
            재발 (이전 #{row.previousFindingId})
          </span>
        )}
      </td>
      <td className={`${TD_CLASS} whitespace-nowrap`}>
        <span className="font-mono text-ink tabular-nums">{formatEffectValue(row.effect)}</span>
        {ci && <span className="block text-xs text-muted">{ci}</span>}
      </td>
      <td className={TD_CLASS}>
        <FindingStatusBadge status={row.status} />
      </td>
      <td className={`${TD_CLASS} text-xs whitespace-nowrap text-ink-2`}>
        {formatKstDateTime(row.firstDetectedMs)}
        <span className="block">{formatKstDateTime(row.lastDetectedMs)}</span>
      </td>
      <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.detectionCount}</td>
    </>
  );
}

type TableProps = Readonly<{ rows: readonly InboxRow[]; triage: BulkAction; dismiss: BulkAction; dismissState: ActionState<BulkResultData>; pending: boolean }>;

/** 선택 상태는 이 컴포넌트에 둔다. 목록 데이터가 바뀌면(처리 성공) 부모가 key를 바꿔 선택을 비운다 */
function InboxTable({ rows, triage, dismiss, dismissState, pending }: TableProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dismissOpen, setDismissOpen] = useState(dismissState.status === 'error');
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const toggle = (id: string, checked: boolean) => setSelected((current) => new Set(checked ? [...current, id] : [...current].filter((value) => value !== id)));
  // 직접 제출: React의 제출 뒤 폼 초기화가 선택 체크박스·기각 입력을 화면 상태와 어긋나게 하지 않도록 한다
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget);
    startTransition(() => (submitter?.getAttribute('value') === 'dismiss' ? dismiss(formData) : triage(formData)));
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-rule bg-sunken px-3 py-2" role="group" aria-label="일괄 분류">
        <p className="text-sm text-ink-2">
          선택 <span className="font-mono tabular-nums">{selected.size}</span>건
        </p>
        <button type="submit" name="intent" value="triage" formNoValidate disabled={selected.size === 0 || pending} className={buttonClass('secondary')}>
          분류 (조사 중)
        </button>
        <button type="button" aria-expanded={dismissOpen} onClick={() => setDismissOpen((open) => !open)} disabled={selected.size === 0 && !dismissOpen} className={buttonClass('danger')}>
          기각…
        </button>
      </div>
      {dismissOpen && (
        <div className="flex flex-col gap-3 rounded-md border border-crit/30 p-3">
          <DismissFields key={dismissState.seq} state={dismissState} />
          <div>
            <button type="submit" name="intent" value="dismiss" disabled={selected.size === 0 || pending} className={buttonClass('danger')}>
              선택 {selected.size}건 기각
            </button>
          </div>
        </div>
      )}
      <TableScroll label="발견사항 인박스 표">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={allSelected} onChange={(event) => setSelected(new Set(event.target.checked ? rows.map((row) => row.id) : []))} className="accent-accent" />
                  <span className="sr-only">모두 선택</span>
                </label>
              </th>
              <th scope="col" className={TH_CLASS}>심각도·신뢰도</th>
              <th scope="col" className={TH_CLASS}>발견사항</th>
              <th scope="col" className={TH_CLASS}>효과 크기</th>
              <th scope="col" className={TH_CLASS}>상태</th>
              <th scope="col" className={TH_CLASS}>최초·최근 탐지</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>탐지 횟수</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={selected.has(row.id) ? 'bg-hydrogen-fill/40' : undefined}>
                <td className={TD_CLASS}>
                  <input type="checkbox" name="findingId" value={row.id} checked={selected.has(row.id)} onChange={(event) => toggle(row.id, event.target.checked)} aria-label={`선택: ${row.title}`} className="accent-accent" />
                </td>
                <FindingCells row={row} />
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </form>
  );
}

type WorkbenchProps = Readonly<{ rows: readonly InboxRow[] }>;

/** 인박스 표 + 일괄 분류·기각. 결과 문구는 표가 다시 마운트돼도 남도록 여기서 들고 있는다 */
export function InboxWorkbench({ rows }: WorkbenchProps) {
  const [triageState, triage, triagePending] = useActionState<ActionState<BulkResultData>, FormData>(triageFindingsAction, IDLE_STATE);
  const [dismissState, dismiss, dismissPending] = useActionState<ActionState<BulkResultData>, FormData>(dismissFindingsAction, IDLE_STATE);
  const [last, setLast] = useState<'triage' | 'dismiss'>('triage');
  const runTriage = (formData: FormData) => {
    setLast('triage');
    triage(formData);
  };
  const runDismiss = (formData: FormData) => {
    setLast('dismiss');
    dismiss(formData);
  };
  const latest = last === 'triage' ? triageState : dismissState;
  const signature = rows.map((row) => `${row.id}:${row.status}`).join(',');

  return (
    <div className="flex flex-col gap-3">
      <ActionMessage state={latest}>{latest.status === 'success' && <BulkResult data={latest.data} />}</ActionMessage>
      <InboxTable key={signature} rows={rows} triage={runTriage} dismiss={runDismiss} dismissState={dismissState} pending={triagePending || dismissPending} />
    </div>
  );
}
