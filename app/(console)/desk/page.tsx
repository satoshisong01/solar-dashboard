import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { InboxFilters } from '@/components/desk/inbox-filters';
import { InboxWorkbench } from '@/components/desk/inbox-table';
import { RunHistory } from '@/components/desk/run-history';
import { RunPanel } from '@/components/desk/run-panel';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getRunFormOptions, listRecentRuns } from '@/lib/data/analysis-runs';
import { INBOX_LIMIT, listInboxRows } from '@/lib/data/findings';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { applyInboxFilter, DEFAULT_INBOX_FILTER, parseInboxFilter, sortInbox } from '@/lib/desk/inbox';

export const metadata: Metadata = { title: '분석 데스크' };

/** 이 화면의 Server Action(분석 실행)은 수십 초~몇 분 걸릴 수 있다 (배포 플랫폼 제한 초).
 * 300은 Vercel Hobby 플랜 상한이다. 더 긴 실행이 필요하면 플랜을 올리거나 npm run analyze로 서버 밖에서 돌린다. */
export const maxDuration = 300;

const RUN_HISTORY_LIMIT = 10;

type DeskPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function DeskPage({ searchParams }: DeskPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const filter = parseInboxFilter({
    site: firstParam(query.site),
    domain: firstParam(query.domain),
    category: firstParam(query.category),
    severity: firstParam(query.severity),
    status: firstParam(query.status),
  });
  const [options, runs, inbox] = await Promise.all([getRunFormOptions(), listRecentRuns(RUN_HISTORY_LIMIT), listInboxRows()]);
  const rows = sortInbox(applyInboxFilter(inbox.rows, filter));
  const filtered = JSON.stringify(filter) !== JSON.stringify(DEFAULT_INBOX_FILTER);

  return (
    <>
      <PageHeader title="분석 데스크" purpose="분석을 실행하고 발견사항(finding)을 분류한 뒤 근거 확인·원인 판별·권고 작성" guide={SCREEN_GUIDES.desk} />

      <Panel title="분석 실행" meta="수동 실행 · 결과는 발견사항으로만 저장">
        {options.sites.length === 0 ? <EmptyNote>등록된 사이트가 없습니다</EmptyNote> : <RunPanel options={options} />}
      </Panel>

      <Panel title="최근 분석 실행" meta={`최근 ${RUN_HISTORY_LIMIT}건`}>
        <RunHistory runs={runs} />
      </Panel>

      <section id="inbox" className="scroll-mt-20">
        <Panel
          title="발견사항 인박스"
          meta={`${rows.length}건 · 심각도×신뢰도 순${inbox.truncated ? ` · 최근 탐지 ${INBOX_LIMIT}건 안에서` : ''}`}
        >
          <InboxFilters filter={filter} siteCodes={options.sites.map((site) => site.code)} />
          {inbox.rows.length === 0 ? (
            <EmptyNote>아직 발견사항이 없습니다. 위에서 사이트와 기간을 골라 분석을 실행하세요.</EmptyNote>
          ) : rows.length === 0 ? (
            <EmptyNote>{filtered ? '필터에 맞는 발견사항이 없습니다' : '열린 발견사항이 없습니다'}</EmptyNote>
          ) : (
            <InboxWorkbench rows={rows} />
          )}
        </Panel>
      </section>
    </>
  );
}
