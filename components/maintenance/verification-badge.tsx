import { CircleCheck, CircleHelp, CircleMinus, Hourglass, OctagonAlert } from 'lucide-react';
import type { ActionProgress } from '@/lib/maintenance/progress';

const VERDICT_TONE: Readonly<Record<string, { readonly icon: typeof CircleCheck; readonly className: string }>> = {
  improved: { icon: CircleCheck, className: 'border-ok/40 bg-ok-fill text-ok' },
  no_change: { icon: CircleMinus, className: 'border-rule-strong bg-sunken text-ink-2' },
  worse: { icon: OctagonAlert, className: 'border-crit/40 bg-crit-fill text-crit' },
  insufficient_data: { icon: CircleHelp, className: 'border-warn/40 bg-warn-fill text-warn' },
};

/** 검증 상태 배지: improved / no_change / worse / insufficient_data / 대기(안정화·after 창·분석 실행 필요) / 검증 안 함. 아이콘 + 글자 */
export function VerificationBadge({ progress }: Readonly<{ progress: ActionProgress }>) {
  const tone = progress.verdict ? VERDICT_TONE[progress.verdict] : null;
  const Icon = tone?.icon ?? (progress.state === 'untracked' ? CircleMinus : Hourglass);
  const className = tone?.className ?? (progress.state === 'untracked' ? 'border-rule bg-surface text-muted' : progress.state === 'ready' ? 'border-accent/50 bg-hydrogen-fill text-ink' : 'border-rule-strong bg-surface text-ink-2');
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {progress.state === 'verified' || progress.state === 'untracked' ? progress.label : `대기 · ${progress.label}`}
    </span>
  );
}

/** 안정화+after 창 진행 막대 */
export function ProgressBar({ fraction, label }: Readonly<{ fraction: number | null; label: string }>) {
  const pct = Math.round((fraction ?? 0) * 100);
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span aria-hidden="true" className="relative h-1.5 w-24 overflow-hidden rounded-full bg-sunken">
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs text-ink-2 tabular-nums">{pct}%</span>
    </span>
  );
}
