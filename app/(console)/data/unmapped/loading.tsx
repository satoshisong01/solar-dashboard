import { DATA_TABS } from '@/components/console/section-tabs';
import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable, SkeletonTabs } from '@/components/ui/skeleton';

/** 미매핑 태그 골격: 머리글(안내 막대 없음) · 하위 탭 · 미매핑 태그 표 · 재처리 대기 */
export default function UnmappedLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader />
      <SkeletonTabs count={DATA_TABS.length} />
      <SkeletonPanel titleClassName="w-28">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-36">
        <Skeleton className="h-24" />
      </SkeletonPanel>
    </>
  );
}
