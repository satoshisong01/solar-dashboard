import { Skeleton, SkeletonBreadcrumb, SkeletonCards, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 사이트 상세 골격: 오늘 KPI · 설비 트리 · 이벤트 타임라인 · 게이트웨이. 설비 화면도 이 골격을 쓴다 (공정도는 따로) */
export default function SiteLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonBreadcrumb />
      <SkeletonHeader />
      <Skeleton className="h-7.5 w-32" />
      <SkeletonPanel titleClassName="w-24">
        <SkeletonCards count={4} />
      </SkeletonPanel>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SkeletonPanel titleClassName="w-24">
          <SkeletonTable rows={6} />
        </SkeletonPanel>
        <SkeletonPanel titleClassName="w-32">
          <SkeletonTable rows={6} />
        </SkeletonPanel>
      </div>
      <SkeletonPanel titleClassName="w-32">
        <SkeletonTable rows={3} />
      </SkeletonPanel>
    </>
  );
}
