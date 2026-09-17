import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 플릿 골격: 보기 전환 · 사이트 × 도메인 매트릭스 */
export default function FleetLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-40">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-11 w-48" />
          <SkeletonTable rows={5} />
        </div>
        <Skeleton className="h-4 w-28" />
      </SkeletonPanel>
    </>
  );
}
