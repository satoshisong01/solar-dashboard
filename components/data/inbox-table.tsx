import { Link2 } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { InboxTag } from '@/lib/data/ingest-status';
import { formatAgo, formatKstDateTime, formatNumber } from '@/lib/format';
import type { PendingReplayGroup } from './replay-panel';

export function mappingHref(tag: Pick<InboxTag, 'gatewayId' | 'sourceKey'>): string {
  const params = new URLSearchParams({ gateway: String(tag.gatewayId), source: tag.sourceKey });
  return `/data/unmapped/map?${params.toString()}`;
}

/** 재처리 대기 태그를 게이트웨이별로 묶는다 (입력 순서 유지) */
export function groupPending(tags: readonly InboxTag[]): readonly PendingReplayGroup[] {
  const gatewayIds = [...new Set(tags.filter((tag) => tag.mapped !== null).map((tag) => tag.gatewayId))];
  return gatewayIds.map((gatewayId) => {
    const inGroup = tags.filter((tag) => tag.gatewayId === gatewayId && tag.mapped !== null);
    return {
      gatewayId,
      gatewayCode: inGroup[0]?.gatewayCode ?? '',
      siteCode: inGroup[0]?.siteCode ?? '',
      tags: inGroup.flatMap((tag) => (tag.mapped ? [{ sourceKey: tag.sourceKey, assetCode: tag.mapped.assetCode, metricKey: tag.mapped.metricKey, qualifier: tag.mapped.qualifier }] : [])),
    };
  });
}

export function UnmappedTable({ tags, nowMs }: Readonly<{ tags: readonly InboxTag[]; nowMs: number }>) {
  if (tags.length === 0) return <EmptyNote>매핑되지 않은 수신 태그가 없습니다</EmptyNote>;

  return (
    <TableScroll label="미매핑 태그 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>원본 태그</th>
            <th scope="col" className={TH_CLASS}>게이트웨이</th>
            <th scope="col" className={TH_CLASS}>단위</th>
            <th scope="col" className={TH_CLASS}>최초 수신</th>
            <th scope="col" className={TH_CLASS}>최근 수신</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>샘플 수</th>
            <th scope="col" className={TH_CLASS}><span className="sr-only">매핑</span></th>
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            <tr key={`${tag.gatewayId}|${tag.sourceKey}`}>
              <th scope="row" className={`${TD_CLASS} font-mono font-medium text-ink`}>{tag.sourceKey}</th>
              <td className={`${TD_CLASS} text-ink-2`}>
                <span className="font-mono">{tag.gatewayCode}</span>
                <span className="block text-xs text-muted">{tag.siteCode}</span>
              </td>
              <td className={`${TD_CLASS} font-mono text-ink-2`}>{tag.unit || '—'}</td>
              <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(tag.firstSeenMs)}</td>
              <td className={`${TD_CLASS} text-xs whitespace-nowrap`}>
                <span className="font-mono">{formatKstDateTime(tag.lastSeenMs)}</span>
                <span className="block text-muted">{formatAgo(tag.lastSeenMs, nowMs)}</span>
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(tag.sampleCount, 0)}</td>
              <td className={TD_CLASS}>
                <Link href={mappingHref(tag)} className="inline-flex items-center gap-1 rounded-md border border-accent px-2.5 py-1 text-sm font-medium whitespace-nowrap text-accent hover:bg-hydrogen-fill">
                  <Link2 aria-hidden="true" className="size-4" />
                  매핑<span className="sr-only"> — {tag.sourceKey}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
