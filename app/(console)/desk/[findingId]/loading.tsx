import { Skeleton, SkeletonBreadcrumb, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 발견사항 상세 골격: 머리글 · 쉬운 요약 · 근거 · 권고 조치 */
export default function FindingLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonBreadcrumb className="w-56" />
      <SkeletonHeader />
      <SkeletonPanel titleClassName="w-28">
        <Skeleton className="h-24" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-24">
        <Skeleton className="h-64" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-36">
        <SkeletonTable rows={4} />
      </SkeletonPanel>
    </>
  );
}
