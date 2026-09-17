import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus } from '@/components/ui/skeleton';
import { FleetBoardSkeleton } from './sections';

/** 플릿 골격: 보기 전환 · 사이트 × 도메인 매트릭스. 매트릭스 골격은 page.tsx의 Suspense fallback과 같다 */
export default function FleetLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-40">
        <FleetBoardSkeleton />
        <Skeleton className="h-4 w-28" />
      </SkeletonPanel>
    </>
  );
}
