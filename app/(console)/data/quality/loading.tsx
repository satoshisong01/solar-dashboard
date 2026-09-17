import { DATA_TABS } from '@/components/console/section-tabs';
import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable, SkeletonTabs } from '@/components/ui/skeleton';

/** 데이터 품질 골격: 머리글(안내 막대 없음) · 하위 탭 · 조건 폼 · 품질 비트 표 · 고착 의심 표 */
export default function QualityLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader />
      <SkeletonTabs count={DATA_TABS.length} />
      <Skeleton className="h-19.5" />
      <SkeletonPanel titleClassName="w-48">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-28">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
    </>
  );
}
