'use client';

import { Repeat } from 'lucide-react';
import Link from 'next/link';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { dismissFindingsAction, triageFindingsAction, type BulkResultData } from '@/app/(console)/desk/actions';
import { ActionMessage, buttonClass } from '@/components/forms/controls';
import { NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { TermLink } from '@/components/ui/term-link';
import { formatEffectWithCi } from '@/lib/desk/effect';
import type { InboxRow } from '@/lib/desk/inbox';
import { CATEGORY_LABELS, detectorLabel } from '@/lib/desk/labels';
import { assetCodeOf } from '@/lib/desk/plain/common';
import { plainHeadline } from '@/lib/desk/plain/headline';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime } from '@/lib/format';
import { DismissFields } from './dismiss-fields';
import { ConfidenceBar, FindingSeverityChip, FindingStatusBadge } from './finding-badges';
import { CHECK_CLASS } from '@/components/ui/form-styles';

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

// lg 미만에서 행은 카드가 된다: 칸 테두리·안쪽 여백을 거두고 카드 테두리 하나로 묶는다
const CARD_CELL = 'max-lg:border-0 max-lg:p-0';
// 머리행이 없는 카드에서만 붙는 값 설명 (표에서는 열 제목이 그 일을 한다)
const CARD_LABEL = 'font-sans text-xs text-muted lg:hidden';

function FindingCells({ row }: Readonly<{ row: InboxRow }>) {
  const effectText = formatEffectWithCi(row.effect);
  const ci = effectText.ci;
  return (
    <>
      <td role="cell" className={`${TD_CLASS} ${CARD_CELL}`}>
        <FindingSeverityChip severity={row.severity} />
        <span className="mt-1 block">
          <ConfidenceBar confidence={row.confidence} />
        </span>
      </td>
      <td role="cell" className={`${TD_CLASS} ${CARD_CELL} min-w-64 max-w-md max-lg:w-full max-lg:min-w-0`}>
        <Link href={`/desk/${row.id}`} className="font-medium text-ink hover:underline">
          {row.title}
        </Link>
        <span className="mt-0.5 block text-sm text-pretty text-ink-2">{plainHeadline({ ...row, assetCode: assetCodeOf(row.assetPath) })}</span>
        <span className="mt-0.5 block text-xs text-muted">
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
      <td role="cell" className={`${TD_CLASS} ${CARD_CELL} whitespace-nowrap`}>
        <span className={CARD_LABEL}>효과 </span>
        <span className="font-mono text-ink tabular-nums">{effectText.value}</span>
        {ci && <span className="block text-xs text-muted">{ci}</span>}
      </td>
      <td role="cell" className={`${TD_CLASS} ${CARD_CELL}`}>
        <FindingStatusBadge status={row.status} />
      </td>
      <td role="cell" className={`${TD_CLASS} ${CARD_CELL} text-xs whitespace-nowrap text-ink-2`}>
        <span className={CARD_LABEL}>최초 </span>
        {formatKstDateTime(row.firstDetectedMs)}
        <span className="block">
          <span className={CARD_LABEL}>최근 </span>
          {formatKstDateTime(row.lastDetectedMs)}
        </span>
      </td>
      <td role="cell" className={`${TD_CLASS} ${NUM_CLASS} ${CARD_CELL}`}>
        <span className={CARD_LABEL}>탐지 </span>
        {row.detectionCount}
        <span className={CARD_LABEL}>회</span>
      </td>
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
      {/* lg 미만에서만 카드 목록으로 바꾼다. DOM은 하나라서 선택 체크박스가 중복 제출되지 않고,
          display를 바꾸면 사라지는 표 역할은 role로 다시 명시한다 */}
      <TableScroll label="발견사항 인박스 표">
        <table role="table" className={`${TABLE_CLASS} max-lg:block max-lg:min-w-0`}>
          <thead role="rowgroup" className="max-lg:hidden">
            <tr>
              <th scope="col" className={TH_CLASS}>
                <label className="inline-flex items-center gap-1 max-lg:min-h-11">
                  <input type="checkbox" checked={allSelected} onChange={(event) => setSelected(new Set(event.target.checked ? rows.map((row) => row.id) : []))} className={CHECK_CLASS} />
                  <span className="sr-only">모두 선택</span>
                </label>
              </th>
              <th scope="col" className={TH_CLASS}>
                급함 <TermLink termId="severity" term="심각도 (급함)" /> · 신뢰도 <TermLink termId="confidence" term="신뢰도" />
              </th>
              <th scope="col" className={TH_CLASS}>발견사항</th>
              <th scope="col" className={TH_CLASS}>
                효과 크기 <TermLink termId="effect" term="효과 크기" />
              </th>
              <th scope="col" className={TH_CLASS}>상태</th>
              <th scope="col" className={TH_CLASS}>최초·최근 탐지</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>탐지 횟수</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="max-lg:flex max-lg:flex-col max-lg:gap-3">
            {rows.map((row) => (
              <tr
                key={row.id}
                role="row"
                className={`max-lg:flex max-lg:flex-wrap max-lg:items-center max-lg:gap-x-3 max-lg:gap-y-1 max-lg:rounded-md max-lg:border max-lg:border-rule max-lg:p-3 ${selected.has(row.id) ? 'bg-hydrogen-fill/40' : ''}`}
              >
                <td role="cell" className={`${TD_CLASS} ${CARD_CELL}`}>
                  <input type="checkbox" name="findingId" value={row.id} checked={selected.has(row.id)} onChange={(event) => toggle(row.id, event.target.checked)} aria-label={`선택: ${row.title}`} className={CHECK_CLASS} />
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
