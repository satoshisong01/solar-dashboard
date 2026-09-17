import { Skeleton, SkeletonHeader, SkeletonStatus } from '@/components/ui/skeleton';

/** 설정 화면 골격: 하위 탭 · 카드. 하위 화면(카탈로그·탐지기 등)도 이 골격을 쓴다 */
export default function SettingsLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader />
      <div className="-mt-2 flex gap-2 overflow-hidden pb-1">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-24 shrink-0" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    </>
  );
}
