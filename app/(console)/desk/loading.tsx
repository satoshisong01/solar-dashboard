import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 분석 데스크 골격: 분석 실행 · 최근 분석 실행 · 발견사항 인박스 */
export default function DeskLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-24">
        <Skeleton className="h-28" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-36">
        <SkeletonTable rows={4} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-40">
        <Skeleton className="h-16" />
        <SkeletonTable rows={8} />
      </SkeletonPanel>
    </>
  );
}
