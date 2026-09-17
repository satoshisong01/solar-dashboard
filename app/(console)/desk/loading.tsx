import { SkeletonHeader, SkeletonPanel, SkeletonStatus } from '@/components/ui/skeleton';
import { InboxSkeleton, RunHistorySkeleton, RunSkeleton } from './sections';

/** 분석 데스크 골격. 영역 골격은 page.tsx의 Suspense fallback과 같은 것을 쓴다 (sections.tsx) */
export default function DeskLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-24">
        <RunSkeleton />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-36">
        <RunHistorySkeleton />
      </SkeletonPanel>
      <InboxSkeleton />
    </>
  );
}
