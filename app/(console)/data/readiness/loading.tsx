import { DATA_TABS } from '@/components/console/section-tabs';
import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable, SkeletonTabs } from '@/components/ui/skeleton';

/** 탐지 준비도 골격: 머리글(안내 막대 없음) · 하위 탭 · 사이트 선택 폼 · 요약 · 준비도 매트릭스 · 확보 순위 */
export default function ReadinessLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader />
      <SkeletonTabs count={DATA_TABS.length} />
      <Skeleton className="h-19.5" />
      <SkeletonPanel titleClassName="w-32">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-18.5" />
          ))}
        </div>
        <Skeleton className="h-10.5" />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-40">
        <SkeletonTable rows={8} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-32">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
    </>
  );
}
