import { Skeleton, SkeletonHeader, SkeletonStatus } from '@/components/ui/skeleton';
import { CountersSkeleton, DataGapsSkeleton, EnergySkeleton, RevenueSkeleton, SafetySkeleton, SiteMapSkeleton, TopFindingsSkeleton } from './sections';

/** 대시보드 화면의 골격. 영역 골격은 page.tsx의 Suspense fallback과 같은 것을 쓴다 (sections.tsx).
 * (today) 라우트 그룹에 둔다 (주소는 그대로 /): (console) 바로 아래에 두면 그것이 콘솔 전체의 로딩 boundary가 되어
 * prefetch가 여기서 멈추고, 다른 화면으로 옮길 때도 대시보드 골격이 먼저 번쩍인다. */
export default function TodayLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <Skeleton className="-mt-3 h-4 w-56" />
      <SafetySkeleton />
      <CountersSkeleton />
      <SiteMapSkeleton />
      <TopFindingsSkeleton />
      <div className="grid gap-6 lg:grid-cols-2">
        <DataGapsSkeleton />
        <RevenueSkeleton />
      </div>
      <EnergySkeleton />
    </>
  );
}
