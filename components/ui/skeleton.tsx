import type { ReactNode } from 'react';

/** 로딩 자리. 스크린리더에는 loading.tsx의 상태 문구만 읽힌다 */
export function Skeleton({ className = '' }: Readonly<{ className?: string }>) {
  return <div aria-hidden="true" className={`motion-safe:animate-pulse rounded-md bg-sunken ${className}`} />;
}

/** PageHeader 자리. 실제 머리글과 같은 테두리·여백을 써서 내용이 들어와도 아래가 밀리지 않는다 */
export function SkeletonHeader({ guide = false }: Readonly<{ guide?: boolean }>) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule pb-5">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-6 w-80 max-w-full" />
      {guide && <Skeleton className="h-9.5 w-full" />}
    </div>
  );
}

/** Panel 자리. Panel과 같은 테두리·여백·간격 */
export function SkeletonPanel({ titleClassName = 'w-32', children }: Readonly<{ titleClassName?: string; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-rule bg-surface p-4 shadow-panel md:p-5">
      <Skeleton className={`h-6 ${titleClassName}`} />
      {children}
    </div>
  );
}

/** 표 자리. 머리행 한 줄과 본문 행 (TH_CLASS·TD_CLASS와 같은 높이) */
export function SkeletonTable({ rows = 6 }: Readonly<{ rows?: number }>) {
  return (
    <div className="flex flex-col">
      <div className="border-b border-rule py-2">
        <Skeleton className="h-4 w-full" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="border-b border-rule py-2">
          <Skeleton className="h-5 w-full" />
        </div>
      ))}
    </div>
  );
}

/** 수치 카드 줄 자리 (할 일 카운터·KPI 타일) */
export function SkeletonCards({ count = 4, className = 'grid-cols-2 lg:grid-cols-4' }: Readonly<{ count?: number; className?: string }>) {
  return (
    <div className={`grid gap-3 ${className}`}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-24.5" />
      ))}
    </div>
  );
}

/** loading.tsx 맨 위에 한 번 둔다. 골격은 aria-hidden이라 이 문구만 읽힌다 */
export function SkeletonStatus() {
  return (
    <p role="status" className="sr-only">
      화면을 불러오는 중입니다
    </p>
  );
}
