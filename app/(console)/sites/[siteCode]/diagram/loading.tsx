import { Skeleton, SkeletonBreadcrumb, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 공정도 골격: 머리글 · 공정흐름 계장도(그림) · 설비 목록 · 계장 태그.
 *  사이트 상세와 배치가 달라 따로 둔다 (사이트 상세는 ../loading.tsx) */
export default function DiagramLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonBreadcrumb className="w-56" />
      <SkeletonHeader />
      <SkeletonPanel titleClassName="w-32">
        {/* 도면은 세로비가 고정이다 (viewBox 1320×600, 최소 폭 66rem) */}
        <Skeleton className="h-120" />
        <Skeleton className="h-5" />
        <Skeleton className="h-7" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-24">
        <SkeletonTable rows={8} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-24">
        <SkeletonTable rows={8} />
      </SkeletonPanel>
    </>
  );
}
