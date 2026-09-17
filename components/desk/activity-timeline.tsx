import { ArrowRightLeft, ClipboardCheck, FileSearch, Wrench, type LucideIcon } from 'lucide-react';
import { EmptyNote } from '@/components/ui/panel';
import type { TimelineEntry, TimelineKind } from '@/lib/desk/timeline';
import { formatKstDateTime } from '@/lib/format';

const KIND_META: Readonly<Record<TimelineKind, { icon: LucideIcon; label: string }>> = {
  transition: { icon: ArrowRightLeft, label: '상태 전이' },
  evidence: { icon: FileSearch, label: '근거' },
  action: { icon: Wrench, label: '조치' },
  verification: { icon: ClipboardCheck, label: '효과 검증' },
};

/** 활동 타임라인: 상태 전이 · 근거 갱신 · 조치 · 검증 결과 (최근 순) */
export function ActivityTimeline({ entries }: Readonly<{ entries: readonly TimelineEntry[] }>) {
  if (entries.length === 0) return <EmptyNote>활동 기록이 없습니다</EmptyNote>;
  return (
    <ol className="flex flex-col">
      {entries.map((entry) => {
        const { icon: Icon, label } = KIND_META[entry.kind];
        return (
          <li key={entry.key} className="flex gap-3 border-l border-rule pb-4 pl-4 last:pb-0">
            <span className="-ml-[1.6rem] flex size-6 shrink-0 items-center justify-center rounded-full border border-rule bg-sunken text-ink-2">
              <Icon aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{label}</span>
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-medium text-ink">{entry.title}</p>
              {entry.detail && <p className="text-sm text-ink-2">{entry.detail}</p>}
              <p className="text-xs text-muted">
                {formatKstDateTime(entry.atMs)} KST{entry.actor ? ` · ${entry.actor}` : ''}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
