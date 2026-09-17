import { InboxFilters } from '@/components/desk/inbox-filters';
import { InboxWorkbench } from '@/components/desk/inbox-table';
import { RunHistory } from '@/components/desk/run-history';
import { RunPanel } from '@/components/desk/run-panel';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { Skeleton, SkeletonPanel, SkeletonTable } from '@/components/ui/skeleton';
import { listRecentRuns, type RunFormOptions } from '@/lib/data/analysis-runs';
import { INBOX_LIMIT, listInboxRows } from '@/lib/data/findings';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { applyInboxFilter, DEFAULT_INBOX_FILTER, parseInboxFilter, sortInbox } from '@/lib/desk/inbox';

/**
 * 분석 데스크의 영역별 조회와 그 자리 골격.
 * 사이트 목록(getRunFormOptions)은 분석 실행과 인박스 필터가 함께 쓰므로 page.tsx에서 한 번만 시작하고
 * 기다리지 않은 Promise를 두 영역에 넘긴다 (조회는 한 번, 화면은 각자 채워진다).
 */

export const RUN_HISTORY_LIMIT = 10;

export async function RunSection({ options }: Readonly<{ options: Promise<RunFormOptions> }>) {
  const resolved = await options;
  return resolved.sites.length === 0 ? <EmptyNote>등록된 사이트가 없습니다</EmptyNote> : <RunPanel options={resolved} />;
}

export function RunSkeleton() {
  return <Skeleton className="h-28" />;
}

export async function RunHistorySection() {
  return <RunHistory runs={await listRecentRuns(RUN_HISTORY_LIMIT)} />;
}

export function RunHistorySkeleton() {
  return <SkeletonTable rows={4} />;
}

type InboxSectionProps = Readonly<{
  options: Promise<RunFormOptions>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}>;

/** 인박스는 건수를 제목 옆에 적으므로 Panel째로 이 경계 안에 둔다 */
export async function InboxSection({ options, searchParams }: InboxSectionProps) {
  const [resolved, query, inbox] = await Promise.all([options, searchParams, listInboxRows()]);
  const filter = parseInboxFilter({
    site: firstParam(query.site),
    domain: firstParam(query.domain),
    category: firstParam(query.category),
    severity: firstParam(query.severity),
    status: firstParam(query.status),
  });
  const rows = sortInbox(applyInboxFilter(inbox.rows, filter));
  const filtered = JSON.stringify(filter) !== JSON.stringify(DEFAULT_INBOX_FILTER);

  return (
    <Panel title="발견사항 인박스" meta={`${rows.length}건 · 심각도×신뢰도 순${inbox.truncated ? ` · 최근 탐지 ${INBOX_LIMIT}건 안에서` : ''}`}>
      <InboxFilters filter={filter} siteCodes={resolved.sites.map((site) => site.code)} />
      {inbox.rows.length === 0 ? (
        <EmptyNote>아직 발견사항이 없습니다. 위에서 사이트와 기간을 골라 분석을 실행하세요.</EmptyNote>
      ) : rows.length === 0 ? (
        <EmptyNote>{filtered ? '필터에 맞는 발견사항이 없습니다' : '열린 발견사항이 없습니다'}</EmptyNote>
      ) : (
        <InboxWorkbench rows={rows} />
      )}
    </Panel>
  );
}

export function InboxSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-40">
      <Skeleton className="h-16" />
      <SkeletonTable rows={8} />
    </SkeletonPanel>
  );
}
