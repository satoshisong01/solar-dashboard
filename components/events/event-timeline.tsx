import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote } from '@/components/ui/panel';
import { SeverityChip } from '@/components/ui/status';
import type { EventRow } from '@/lib/data/sites';
import { formatKstDateTimeSeconds } from '@/lib/format';

type EventTimelineProps = Readonly<{
  events: readonly EventRow[];
  /** 설비 링크를 만들 사이트 코드 (여러 사이트 이벤트면 각 행의 siteCode를 쓴다) */
  linkAssets?: boolean;
  emptyText?: string;
}>;

/** 최근 이벤트부터 시간순 목록. 안전 이벤트는 확인 여부를 함께 표시한다 */
export function EventTimeline({ events, linkAssets = true, emptyText = '기록된 이벤트가 없습니다' }: EventTimelineProps) {
  if (events.length === 0) return <EmptyNote>{emptyText}</EmptyNote>;

  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li key={event.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-rule py-2 last:border-b-0">
          <time dateTime={new Date(event.tsMs).toISOString()} className="pt-0.5 font-mono text-xs whitespace-nowrap text-muted">
            {formatKstDateTimeSeconds(event.tsMs)}
          </time>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <SeverityChip severity={event.severity} />
              <span className="font-mono text-ink">{event.code}</span>
              {event.isSafety && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-crit">
                  <ShieldAlert aria-hidden="true" className="size-3.5" />
                  안전 {event.ackedAtMs === null ? '· 미확인' : '· 확인됨'}
                </span>
              )}
            </p>
            <p className="text-xs text-ink-2">
              {event.assetId !== null && event.assetName ? (
                linkAssets ? (
                  <Link href={`/sites/${encodeURIComponent(event.siteCode)}/assets/${event.assetId}`} className="hover:underline">
                    {event.assetName}
                  </Link>
                ) : (
                  event.assetName
                )
              ) : (
                <span className="font-mono">{event.sourceKey}</span>
              )}
              {event.text && <span className="text-muted"> — {event.text}</span>}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
