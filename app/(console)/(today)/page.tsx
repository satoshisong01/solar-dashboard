import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { requireAdmin } from '@/lib/auth/dal';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';
import {
  CountersSection,
  CountersSkeleton,
  DataGapsSection,
  DataGapsSkeleton,
  EnergySection,
  EnergySkeleton,
  RevenueSection,
  RevenueSkeleton,
  SafetySection,
  SafetySkeleton,
  SiteMapSection,
  SiteMapSkeleton,
  TopFindingsSection,
  TopFindingsSkeleton,
} from './sections';

export const metadata: Metadata = { title: '대시보드' };

/** 제목·기준 시각은 바로 그리고, 영역별 조회는 Suspense 경계 안에서 끝나는 대로 채운다 (sections.tsx) */
export default async function DashboardPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();

  return (
    <>
      <PageHeader title="대시보드" purpose="출근 후 5분 안에 할 일과 밤사이 변화 파악" guide={SCREEN_GUIDES.dashboard} />
      <p className="-mt-3 text-xs text-muted">기준 시각 {formatKstDateTime(nowMs)} KST</p>
      <Suspense fallback={<SafetySkeleton />}>
        <SafetySection />
      </Suspense>
      <Suspense fallback={<CountersSkeleton />}>
        <CountersSection nowMs={nowMs} />
      </Suspense>
      <Suspense fallback={<SiteMapSkeleton />}>
        <SiteMapSection nowMs={nowMs} />
      </Suspense>
      <Suspense fallback={<TopFindingsSkeleton />}>
        <TopFindingsSection nowMs={nowMs} />
      </Suspense>
      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<DataGapsSkeleton />}>
          <DataGapsSection nowMs={nowMs} />
        </Suspense>
        <Suspense fallback={<RevenueSkeleton />}>
          <RevenueSection nowMs={nowMs} />
        </Suspense>
      </div>
      <Suspense fallback={<EnergySkeleton />}>
        <EnergySection nowMs={nowMs} />
      </Suspense>
    </>
  );
}
