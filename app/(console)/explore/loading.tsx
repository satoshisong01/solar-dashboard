import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus } from '@/components/ui/skeleton';

/** 탐색기 골격: 왼쪽 포인트 선택 · 오른쪽 시계열 */
export default function ExploreLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <SkeletonPanel titleClassName="w-28">
          <Skeleton className="h-96" />
        </SkeletonPanel>
        <SkeletonPanel titleClassName="w-20">
          <Skeleton className="h-11" />
          <Skeleton className="h-80" />
        </SkeletonPanel>
      </div>
    </>
  );
}
