import { Skeleton } from '@/components/ui/skeleton';

/** 콘솔 화면 공용 로딩 스켈레톤 (제목 · 요약 카드 · 표/차트 자리) */
export default function ConsoleLoading() {
  return (
    <div className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        화면을 불러오는 중입니다
      </p>
      <div className="flex flex-col gap-2 border-b border-rule pb-5">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20" />
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
