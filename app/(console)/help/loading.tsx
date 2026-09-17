import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus } from '@/components/ui/skeleton';

/** 용어집 골격: 목차 · 용어 카드 */
export default function HelpLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-20">
        <Skeleton className="h-12" />
      </SkeletonPanel>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
    </>
  );
}
