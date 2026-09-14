import type { Metadata } from 'next';
import { groupPending, UnmappedTable } from '@/components/data/inbox-table';
import { ReplayPanel } from '@/components/data/replay-panel';
import { PageHeader } from '@/components/console/page-header';
import { DATA_TABS, SectionTabs } from '@/components/console/section-tabs';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getUnmappedInbox } from '@/lib/data/ingest-status';
import { requestTimeMs } from '@/lib/data/time';

export const metadata: Metadata = { title: '미매핑 태그' };

export default async function UnmappedPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const inbox = await getUnmappedInbox();
  const unmapped = inbox.filter((tag) => tag.mapped === null);

  return (
    <>
      <PageHeader title="데이터" purpose="수집 상태·데이터 품질 관리, 데이터 계약 협의 지원" />
      <SectionTabs label="데이터 하위 화면" tabs={DATA_TABS} current="/data/unmapped" />

      <Panel title="미매핑 태그" meta={`${unmapped.length}개 · 거부하지 않고 원본을 보존해 두었습니다`}>
        <UnmappedTable tags={unmapped} nowMs={nowMs} />
      </Panel>

      <Panel title="매핑됨 · 재처리 대기" meta="보존된 원본 배치에서 매핑한 태그의 과거 값을 채웁니다 (이미 있는 값은 건너뜀)">
        <ReplayPanel groups={groupPending(inbox)} />
      </Panel>
    </>
  );
}
