import { Skeleton, SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 데이터 화면 골격: 하위 탭 · 표. 하위 화면(미매핑 태그·데이터 품질·탐지 준비도)도 이 골격을 쓴다 */
export default function DataLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <div className="-mt-2 flex gap-2 pb-1">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-24" />
        ))}
      </div>
      <SkeletonPanel titleClassName="w-40">
        <SkeletonTable rows={6} />
      </SkeletonPanel>
    </>
  );
}
