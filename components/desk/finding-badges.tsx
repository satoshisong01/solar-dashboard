import { statusLabel, type FindingStatus } from '@/lib/analysis/transition-rules';
import { severityLabel } from '@/lib/desk/labels';
import { severityAction } from '@/lib/desk/plain/common';

const SEVERITY_TONE: readonly string[] = [
  'border-rule bg-surface text-muted',
  'border-rule bg-surface text-muted',
  'border-rule-strong bg-sunken text-ink-2',
  'border-warn/40 bg-warn-fill text-warn',
  'border-crit/40 bg-crit-fill text-crit',
  'border-crit bg-crit-fill text-crit',
];

/** 심각도 1~5 칩. 보이는 글자는 할 일의 급함('바로 확인')이고 숫자는 작게 병기한다 (색만으로 구분하지 않음).
 *  화면 낭독기에는 원래 이름('심각도 4 · 높음')을 먼저 읽힌다 */
export function FindingSeverityChip({ severity }: Readonly<{ severity: number }>) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-xs font-medium whitespace-nowrap ${SEVERITY_TONE[severity] ?? SEVERITY_TONE[0]}`}>
      <span className="sr-only">심각도 {severityLabel(severity)} · </span>
      {severityAction(severity)}
      <span aria-hidden="true" className="font-mono text-[0.625rem] opacity-70 tabular-nums">
        {severity}
      </span>
    </span>
  );
}

/** 신뢰도 0~1 막대 + 백분율 */
export function ConfidenceBar({ confidence }: Readonly<{ confidence: number }>) {
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`신뢰도 ${pct}%`}>
      <span aria-hidden="true" className="relative h-1.5 w-12 overflow-hidden rounded-full bg-sunken">
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs text-ink-2 tabular-nums">
        <span className="sr-only">신뢰도 </span>
        {pct}%
      </span>
    </span>
  );
}

const STATUS_TONE: Readonly<Record<FindingStatus, string>> = {
  new: 'border-accent/50 bg-hydrogen-fill text-ink',
  reopened: 'border-warn/40 bg-warn-fill text-warn',
  triaged: 'border-rule-strong bg-sunken text-ink-2',
  in_report: 'border-rule-strong bg-sunken text-ink-2',
  action_taken: 'border-rule-strong bg-surface text-ink-2',
  verified: 'border-ok/40 bg-ok-fill text-ok',
  dismissed: 'border-rule bg-surface text-muted',
};

export function FindingStatusBadge({ status }: Readonly<{ status: FindingStatus }>) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_TONE[status]}`}>{statusLabel(status)}</span>;
}
