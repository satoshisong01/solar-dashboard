import { CircleAlert, CircleCheck } from 'lucide-react';
import { reportStatusLabel } from '@/lib/report/citations';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'border-accent/50 bg-hydrogen-fill text-ink',
  approved: 'border-ok/40 bg-ok-fill text-ok',
  superseded: 'border-rule bg-surface text-muted',
};

export function ReportStatusBadge({ status }: Readonly<{ status: string }>) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_TONE[status] ?? STATUS_TONE.superseded}`}>{reportStatusLabel(status)}</span>;
}

/** 검증기 결과: 통과 / 문제 n건 (아이콘 + 글자) */
export function ValidationBadge({ ok, issueCount }: Readonly<{ ok: boolean; issueCount: number }>) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-ok">
      <CircleCheck aria-hidden="true" className="size-3.5" />
      검증 통과
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-crit">
      <CircleAlert aria-hidden="true" className="size-3.5" />
      문제 {issueCount}건
    </span>
  );
}
