'use client';

import { Lock, PencilLine, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { saveReportBlockAction, setReportBlockInclusionAction, type ReviewResultData } from '@/app/(console)/reports/actions';
import { ActionMessage, buttonClass, CONTROL_CLASS, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime } from '@/lib/format';
import type { CitationChip } from '@/lib/report/citations';
import { BLOCK_TEXT_MAX, EXCLUDE_REASON_MAX, tokenPreservationError, type ReviewBlock } from '@/lib/report/review';

type Mode = 'view' | 'edit' | 'exclude';

type Props = Readonly<{
  reportId: string;
  block: ReviewBlock;
  /** 초안이고 고정 문구가 아니면 편집할 수 있다 */
  editable: boolean;
  citations: readonly CitationChip[];
  issues: readonly string[];
}>;

function Chips({ block, citations }: Readonly<{ block: ReviewBlock; citations: readonly CitationChip[] }>) {
  const numbers = block.numberTokens.filter((t) => t.format !== 'label');
  if (citations.length === 0 && numbers.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {citations.map((chip) =>
        chip.href ? (
          <Link key={chip.id} href={chip.href} className="rounded border border-accent/40 bg-hydrogen-fill px-1.5 py-px text-ink hover:underline">
            {chip.label}
          </Link>
        ) : (
          <span key={chip.id} className="rounded border border-rule bg-sunken px-1.5 py-px text-ink-2">
            {chip.label}
          </span>
        ),
      )}
      {numbers.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1" aria-label="잠긴 숫자">
          <Lock aria-hidden="true" className="size-3 text-muted" />
          {numbers.map((t, i) => (
            <span key={`${t.path}-${i}`} title={`근거 ${t.path}`} className="rounded border border-rule-strong px-1 font-mono text-ink-2 tabular-nums">
              {t.text}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** 리포트 블록 하나: 본문·인용 칩·잠긴 숫자, 초안이면 문장 편집(숫자 보존 검사)과 포함/제외(사유) */
export function BlockCard({ reportId, block, editable, citations, issues }: Props) {
  const [saveState, save] = useActionState<ActionState<ReviewResultData>, FormData>(saveReportBlockAction, IDLE_STATE);
  const [inclusionState, include] = useActionState<ActionState<ReviewResultData>, FormData>(setReportBlockInclusionAction, IDLE_STATE);
  const [mode, setMode] = useState<Mode>('view');
  const [openedAt, setOpenedAt] = useState(0);
  const [draft, setDraft] = useState(block.text);
  const saved = saveState.status === 'success' && saveState.seq > openedAt;
  const decided = inclusionState.status === 'success' && inclusionState.seq > openedAt;
  const current: Mode = (mode === 'edit' && saved) || (mode === 'exclude' && decided) ? 'view' : mode;
  const tokenError = current === 'edit' ? tokenPreservationError(block.numberTokens, draft) : null;
  const open = (next: Mode) => {
    setOpenedAt(Math.max(saveState.seq, inclusionState.seq));
    setDraft(block.text);
    setMode(next);
  };

  return (
    <div id={`block-${block.id}`} className={`flex scroll-mt-20 flex-col gap-2 rounded-md border px-3 py-2.5 ${issues.length > 0 ? 'border-crit/50' : 'border-rule'} ${block.included ? '' : 'bg-sunken'}`}>
      {current === 'edit' ? (
        <form action={save} className="flex flex-col gap-2">
          <input type="hidden" name="reportId" value={reportId} />
          <input type="hidden" name="blockId" value={block.id} />
          <label htmlFor={`text-${block.id}`} className="text-xs font-medium text-ink-2">
            문장 (숫자·이름은 바꿀 수 없습니다)
          </label>
          <textarea id={`text-${block.id}`} name="text" rows={4} maxLength={BLOCK_TEXT_MAX} value={draft} onChange={(event) => setDraft(event.target.value)} aria-invalid={tokenError !== null} className={CONTROL_CLASS} />
          {tokenError && (
            <p role="alert" className="text-xs text-crit">
              {tokenError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton pendingText="저장 중…" disabled={tokenError !== null}>
              문장 저장
            </SubmitButton>
            <button type="button" onClick={() => setMode('view')} className={buttonClass('secondary')}>
              취소
            </button>
          </div>
        </form>
      ) : (
        <p className={`text-sm leading-relaxed whitespace-pre-line ${block.included ? 'text-ink' : 'text-muted line-through'}`}>{block.text}</p>
      )}
      {!block.included && <p className="text-xs text-ink-2">제외 사유: {block.excludeReason ?? '—'}</p>}
      <Chips block={block} citations={citations} />
      {block.text !== block.originalText && block.editedBy && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">
            편집됨 · {block.editedBy}
            {block.editedAt !== null && ` · ${formatKstDateTime(block.editedAt)}`}
          </summary>
          <p className="mt-1 whitespace-pre-line">원문: {block.originalText}</p>
        </details>
      )}
      {issues.map((issue) => (
        <p key={issue} className="text-xs text-crit">
          {issue}
        </p>
      ))}
      {editable && current === 'exclude' && (
        <form action={include} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="reportId" value={reportId} />
          <input type="hidden" name="blockId" value={block.id} />
          <input type="hidden" name="included" value="0" />
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
            제외 사유 (필수)
            <input name="reason" required maxLength={EXCLUDE_REASON_MAX} className={CONTROL_CLASS} />
          </label>
          <SubmitButton pendingText="제외 중…" variant="danger">
            제외
          </SubmitButton>
          <button type="button" onClick={() => setMode('view')} className={buttonClass('secondary')}>
            취소
          </button>
        </form>
      )}
      {editable && current === 'view' && (
        <div className="flex flex-wrap gap-2">
          {block.included && (
            <>
              <button type="button" onClick={() => open('edit')} className={buttonClass('secondary')}>
                <PencilLine aria-hidden="true" className="size-4" />
                문장 편집
              </button>
              <button type="button" onClick={() => open('exclude')} className={buttonClass('secondary')}>
                <X aria-hidden="true" className="size-4" />
                제외
              </button>
            </>
          )}
          {!block.included && (
            <form action={include}>
              <input type="hidden" name="reportId" value={reportId} />
              <input type="hidden" name="blockId" value={block.id} />
              <input type="hidden" name="included" value="1" />
              <input type="hidden" name="reason" value="" />
              <SubmitButton pendingText="포함 중…" variant="secondary">
                <RotateCcw aria-hidden="true" className="size-4" />
                다시 포함
              </SubmitButton>
            </form>
          )}
        </div>
      )}
      {block.locked && (
        <p className="inline-flex items-center gap-1 text-xs text-muted">
          <Lock aria-hidden="true" className="size-3" />
          고정 문구 · 편집·제외할 수 없습니다
        </p>
      )}
      <ActionMessage state={saveState.seq >= inclusionState.seq ? saveState : inclusionState} />
    </div>
  );
}
