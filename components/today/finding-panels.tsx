import { ArrowRight, Repeat } from 'lucide-react';
import Link from 'next/link';
import { ConfidenceBar, FindingSeverityChip, FindingStatusBadge } from '@/components/desk/finding-badges';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { VERIFICATION_ARRIVAL_MS, type FindingWorkCounts } from '@/lib/data/findings';
import { formatEffectValue } from '@/lib/desk/effect';
import type { InboxRow } from '@/lib/desk/inbox';
import { formatAgo, formatDuration } from '@/lib/format';

const LINK_CLASS = 'inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline';

/** 할 일 카운터: 새 발견사항 · 조사 중 · 조치 후 검증 대기 · 검증 결과 도착 */
export function WorkCountersPanel({ counts }: Readonly<{ counts: FindingWorkCounts }>) {
  const items = [
    { label: '새 발견사항', value: counts.newCount, href: '/desk?status=new#inbox', note: '분류 전' },
    { label: '조사 중', value: counts.triaged, href: '/desk?status=triaged#inbox', note: '분류됨' },
    { label: '조치 후 검증 대기', value: counts.awaitingVerification, href: '/desk?status=action_taken#inbox', note: '조치 완료' },
    { label: '검증 결과 도착', value: counts.verificationsArrived, href: '/desk?status=all#inbox', note: `최근 ${formatDuration(VERIFICATION_ARRIVAL_MS)} 계산` },
  ];
  return (
    <Panel title="할 일" meta="발견사항 상태 기준">
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.label}>
            <Link href={item.href} className="flex flex-col gap-1 rounded-md border border-rule p-3 transition-colors hover:bg-sunken">
              <span className="text-xs text-ink-2">{item.label}</span>
              <span className="font-mono text-2xl font-semibold text-ink tabular-nums">{item.value}</span>
              <span className="text-xs text-muted">{item.note}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** 신규·악화 발견사항 Top N (새 발견·다시 열림, 심각도×신뢰도 순) */
export function TopFindingsPanel({ rows, nowMs, limit }: Readonly<{ rows: readonly InboxRow[]; nowMs: number; limit: number }>) {
  return (
    <Panel
      title="신규·악화 발견사항"
      meta={`새 발견·다시 열림 상위 ${limit}건 · 심각도×신뢰도 순`}
      action={
        <Link href="/desk" className={LINK_CLASS}>
          분석 데스크
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      {rows.length === 0 ? (
        <EmptyNote>새로 들어온 발견사항이 없습니다. 분석 데스크에서 분석을 실행하면 표시됩니다</EmptyNote>
      ) : (
        <ol className="flex flex-col divide-y divide-rule">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
              <FindingSeverityChip severity={row.severity} />
              <div className="flex min-w-0 flex-1 flex-col">
                <Link href={`/desk/${row.id}`} className="font-medium text-ink hover:underline">
                  {row.title}
                </Link>
                <span className="text-xs text-ink-2">
                  {row.siteCode}
                  {row.assetPath ? ` · ${row.assetPath.replace(`${row.siteCode}/`, '')}` : ''} · 최근 탐지 {formatAgo(row.lastDetectedMs, nowMs)}
                  {row.previousFindingId && (
                    <span className="ml-1 inline-flex items-center gap-0.5 text-warn">
                      <Repeat aria-hidden="true" className="size-3" />
                      재발
                    </span>
                  )}
                </span>
              </div>
              <span className="font-mono text-sm text-ink tabular-nums">{formatEffectValue(row.effect)}</span>
              <ConfidenceBar confidence={row.confidence} />
              <FindingStatusBadge status={row.status} />
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
