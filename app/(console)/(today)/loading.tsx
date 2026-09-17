import { Skeleton, SkeletonCards, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 오늘 화면의 골격.
 * (today) 라우트 그룹에 둔다 (주소는 그대로 /): (console) 바로 아래에 두면 그것이 콘솔 전체의 로딩 boundary가 되어
 * prefetch가 여기서 멈추고, 다른 화면으로 옮길 때도 오늘 골격이 먼저 번쩍인다. */
export default function TodayLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <Skeleton className="-mt-3 h-4 w-56" />
      <Skeleton className="h-10.5" />
      <SkeletonPanel titleClassName="w-16">
        <SkeletonCards count={5} className="grid-cols-2 lg:grid-cols-5" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-28">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-56 sm:h-72" />
        </div>
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-44">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
      <div className="grid gap-6 lg:grid-cols-2">
        <SkeletonPanel titleClassName="w-28">
          <SkeletonTable rows={3} />
        </SkeletonPanel>
        <SkeletonPanel titleClassName="w-24">
          <SkeletonTable rows={3} />
        </SkeletonPanel>
      </div>
      <SkeletonPanel titleClassName="w-52">
        <SkeletonTable rows={5} />
      </SkeletonPanel>
    </>
  );
}
