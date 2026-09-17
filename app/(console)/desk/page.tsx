import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getRunFormOptions } from '@/lib/data/analysis-runs';
import { listInboxRows } from '@/lib/data/findings';
import type { SearchParamValue } from '@/lib/data/range';
import { DigestSection, DigestSkeleton, InboxSection, InboxSkeleton, RunHistorySection, RunHistorySkeleton, RUN_HISTORY_LIMIT, RunSection, RunSkeleton } from './sections';

export const metadata: Metadata = { title: '분석 데스크' };

/** 이 화면의 Server Action(분석 실행)은 수십 초~몇 분 걸릴 수 있다 (배포 플랫폼 제한 초).
 * 300은 Vercel Hobby 플랜 상한이다. 더 긴 실행이 필요하면 플랜을 올리거나 npm run analyze로 서버 밖에서 돌린다. */
export const maxDuration = 300;

type DeskPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

/** 제목과 패널 틀은 바로 그리고, 영역별 조회는 Suspense 경계 안에서 끝나는 대로 채운다 (sections.tsx) */
export default async function DeskPage({ searchParams }: DeskPageProps) {
  await requireAdmin();
  // 기다리지 않는다: 분석 실행과 인박스 필터가 같은 조회 결과를 나눠 쓰고, 발견사항 목록은 종합 요약과 인박스가 나눠 쓴다
  const options = getRunFormOptions();
  const inbox = listInboxRows();

  return (
    <>
      <PageHeader title="분석 데스크" purpose="분석을 실행하고 발견사항(finding)을 분류한 뒤 근거 확인·원인 판별·권고 작성" guide={SCREEN_GUIDES.desk} />

      <Suspense fallback={<DigestSkeleton />}>
        <DigestSection inbox={inbox} searchParams={searchParams} />
      </Suspense>

      <Panel title="분석 실행" meta="수동 실행 · 결과는 발견사항으로만 저장">
        <Suspense fallback={<RunSkeleton />}>
          <RunSection options={options} />
        </Suspense>
      </Panel>

      <Panel title="최근 분석 실행" meta={`최근 ${RUN_HISTORY_LIMIT}건`}>
        <Suspense fallback={<RunHistorySkeleton />}>
          <RunHistorySection />
        </Suspense>
      </Panel>

      <section id="inbox" className="scroll-mt-20">
        <Suspense fallback={<InboxSkeleton />}>
          <InboxSection options={options} inbox={inbox} searchParams={searchParams} />
        </Suspense>
      </section>
    </>
  );
}
