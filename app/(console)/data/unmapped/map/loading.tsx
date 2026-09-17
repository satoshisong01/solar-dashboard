import { Skeleton, SkeletonBreadcrumb, SkeletonHeader, SkeletonStatus } from '@/components/ui/skeleton';

/** 태그 매핑 골격: 위치 표시 · 머리글 · 매핑 작업대. 미매핑 목록과 배치가 달라 따로 둔다 (목록은 ../loading.tsx) */
export default function MapTagLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonBreadcrumb className="w-56" />
      <SkeletonHeader />
      <Skeleton className="h-96" />
    </>
  );
}
