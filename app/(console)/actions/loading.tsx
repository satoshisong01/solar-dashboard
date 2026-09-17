import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 조치 추적 골격: 검증 대기 큐 · 조치 목록 · 직접 등록 · CSV 가져오기 */
export default function ActionsLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <Skeleton className="h-16" />
      <SkeletonPanel titleClassName="w-28">
        <SkeletonTable rows={3} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-24">
        <Skeleton className="h-14 w-64 max-w-full" />
        <SkeletonTable rows={6} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-32">
        <Skeleton className="h-32" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-32">
        <Skeleton className="h-24" />
      </SkeletonPanel>
    </>
  );
}
