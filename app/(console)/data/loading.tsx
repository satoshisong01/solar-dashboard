import { DATA_TABS } from '@/components/console/section-tabs';
import { SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable, SkeletonTabs } from '@/components/ui/skeleton';

/** 데이터 화면(게이트웨이 수집 상태) 골격. 안내 막대는 이 화면에만 있다 — 하위 탭은 각자 loading.tsx를 쓴다 */
export default function DataLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonTabs count={DATA_TABS.length} />
      <SkeletonPanel titleClassName="w-40">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
    </>
  );
}
