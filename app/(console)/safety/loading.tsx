import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 안전 화면 골격: 안전감시 공백 · 미확인 안전 이벤트 · 확인 이력 */
export default function SafetyLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <Skeleton className="h-16" />
      <SkeletonPanel titleClassName="w-32">
        <SkeletonTable rows={3} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-40">
        <SkeletonTable rows={5} />
      </SkeletonPanel>
      <SkeletonPanel titleClassName="w-24">
        <SkeletonTable rows={5} />
      </SkeletonPanel>
    </>
  );
}
