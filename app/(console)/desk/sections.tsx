import { DigestCard } from '@/components/desk/digest-card';
import { InboxFilters } from '@/components/desk/inbox-filters';
import { InboxWorkbench } from '@/components/desk/inbox-table';
import { RunHistory } from '@/components/desk/run-history';
import { RunPanel } from '@/components/desk/run-panel';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { Skeleton, SkeletonPanel, SkeletonTable } from '@/components/ui/skeleton';
import { getActiveRun, getLastRunFinishedMs, listRecentRuns, type RunFormOptions } from '@/lib/data/analysis-runs';
import { buildDeskDigest } from '@/lib/data/finding-digest';
import { INBOX_LIMIT, type listInboxRows } from '@/lib/data/findings';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { applyInboxFilter, DEFAULT_INBOX_FILTER, parseInboxFilter, sortInbox } from '@/lib/desk/inbox';

/**
 * 분석 데스크의 영역별 조회와 그 자리 골격.
 * 사이트 목록(getRunFormOptions)과 발견사항 목록(listInboxRows)은 여러 영역이 함께 쓰므로 page.tsx에서 한 번만 시작하고
 * 기다리지 않은 Promise를 각 영역에 넘긴다 (조회는 한 번, 화면은 각자 채워진다).
 */

export const RUN_HISTORY_LIMIT = 10;

type InboxRows = Awaited<ReturnType<typeof listInboxRows>>;

export async function RunSection({ options }: Readonly<{ options: Promise<RunFormOptions> }>) {
  // 진행 중인 실행이 있으면 함께 넘긴다: 실행 중에 화면을 떠났다 돌아와도 진행 표시가 이어진다
  const [resolved, activeRun] = await Promise.all([options, getActiveRun()]);
  return resolved.sites.length === 0 ? <EmptyNote>등록된 사이트가 없습니다</EmptyNote> : <RunPanel options={resolved} activeRun={activeRun} />;
}

/** 분석 실행 폼 자리: 안내 한 줄 · 사이트 고르기 · 설비 고르기 · 기간 · 실행 버튼 (사이트가 한 줄에 들어갈 때의 높이) */
export function RunSkeleton() {
  return <Skeleton className="h-62" />;
}

export async function RunHistorySection() {
  return <RunHistory runs={await listRecentRuns(RUN_HISTORY_LIMIT)} />;
}

export function RunHistorySkeleton() {
  return <SkeletonTable rows={4} />;
}

type DigestSectionProps = Readonly<{
  inbox: Promise<InboxRows>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}>;

/** 맨 위 종합 요약: 인박스와 같은 발견사항을 같은 필터로 세고, 문장은 저장해 두었다가 묶음이 바뀔 때만 다시 만든다 */
export async function DigestSection({ inbox, searchParams }: DigestSectionProps) {
  const [all, query] = await Promise.all([inbox, searchParams]);
  const { site } = parseInboxFilter({ site: firstParam(query.site) });
  const [{ stats, digest }, lastRunMs] = await Promise.all([buildDeskDigest(all, site), getLastRunFinishedMs()]);
  return <DigestCard stats={stats} summary={digest?.summary ?? null} source={digest?.source ?? 'template'} model={digest?.model ?? null} lastRunMs={lastRunMs} />;
}

/** 종합 요약 카드 자리. DigestCard와 같은 테두리·여백·간격에 같은 높이의 줄을 둔다
 *  (제목 줄 + 다시 생성 버튼 · 큰 문장 한 줄 · 작은 문장 세 줄 · 상세 보기 버튼) */
export function DigestSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-accent/40 bg-hydrogen-fill/40 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <Skeleton className="h-8.5 w-72 max-w-full" />
        <Skeleton className="h-8.5 w-28" />
      </div>
      {/* 글줄 높이 그대로: 큰 문장 text-lg/leading-snug = 24.75px, 작은 문장 text-sm/leading-relaxed = 22.75px */}
      <Skeleton className="h-[24.75px] w-96 max-w-full" />
      {['breakdown', 'urgency', 'nextStep'].map((line) => (
        <Skeleton key={line} className="h-[22.75px] w-full" />
      ))}
      <Skeleton className="h-9.5 w-56 max-w-full" />
    </div>
  );
}

type InboxSectionProps = Readonly<{
  options: Promise<RunFormOptions>;
  inbox: Promise<InboxRows>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}>;

/** 인박스는 건수를 제목 옆에 적으므로 Panel째로 이 경계 안에 둔다 */
export async function InboxSection({ options, inbox, searchParams }: InboxSectionProps) {
  const [resolved, query, all] = await Promise.all([options, searchParams, inbox]);
  const filter = parseInboxFilter({
    site: firstParam(query.site),
    domain: firstParam(query.domain),
    category: firstParam(query.category),
    severity: firstParam(query.severity),
    status: firstParam(query.status),
  });
  const rows = sortInbox(applyInboxFilter(all.rows, filter));
  const filtered = JSON.stringify(filter) !== JSON.stringify(DEFAULT_INBOX_FILTER);

  return (
    <Panel title="발견사항 인박스" meta={`${rows.length}건 · 심각도×신뢰도 순${all.truncated ? ` · 최근 탐지 ${INBOX_LIMIT}건 안에서` : ''}`}>
      <InboxFilters filter={filter} siteCodes={resolved.sites.map((site) => site.code)} />
      {all.rows.length === 0 ? (
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
