import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 코칭 리포트 골격: 리포트 만들기 · 리포트 목록. 리포트 상세도 이 골격을 쓴다 */
export default function ReportsLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-32">
        <Skeleton className="h-24" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-28">
        <SkeletonTable rows={5} />
      </SkeletonPanel>
    </>
  );
}
