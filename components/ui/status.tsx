import { CircleCheck, CircleHelp, CircleMinus, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { StatusLevel } from '@/lib/data/fleet-status';
import { SEVERITY_LABELS, type EventSeverity } from '@/lib/data/severity';

export const STATUS_META: Readonly<Record<StatusLevel, Readonly<{ label: string; icon: LucideIcon; className: string }>>> = {
  ok: { label: '정상', icon: CircleCheck, className: 'border-ok/40 bg-ok-fill text-ok' },
  warn: { label: '주의', icon: TriangleAlert, className: 'border-warn/40 bg-warn-fill text-warn' },
  crit: { label: '위험', icon: OctagonAlert, className: 'border-crit/40 bg-crit-fill text-crit' },
  unknown: { label: '데이터 없음', icon: CircleHelp, className: 'border-rule-strong bg-sunken text-ink-2' },
  na: { label: '해당 없음', icon: CircleMinus, className: 'border-rule bg-sunken text-muted' },
};

/** 상태는 색만으로 구분하지 않는다: 아이콘과 글자를 함께 쓴다 */
export function StatusBadge({ level, className = '' }: Readonly<{ level: StatusLevel; className?: string }>) {
  const { label, icon: Icon, className: tone } = STATUS_META[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone} ${className}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

const SEVERITY_TONE: Readonly<Record<EventSeverity, string>> = {
  info: 'border-rule bg-sunken text-ink-2',
  minor: 'border-rule-strong bg-sunken text-ink-2',
  major: 'border-warn/40 bg-warn-fill text-warn',
  critical: 'border-crit/40 bg-crit-fill text-crit',
};

export function SeverityChip({ severity }: Readonly<{ severity: EventSeverity }>) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-xs font-medium whitespace-nowrap ${SEVERITY_TONE[severity]}`}>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}
