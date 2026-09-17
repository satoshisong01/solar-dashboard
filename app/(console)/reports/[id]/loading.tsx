import { Skeleton, SkeletonBreadcrumb, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 리포트 상세 골격: 머리 패널(리포트 정보 · 인쇄 링크 · 승인) · 검증기 결과 · 본문 절 · 근거 팩 · 같은 기간 리포트.
 *  목록 화면과 배치가 달라 따로 둔다 (목록은 ../loading.tsx) */
export default function ReportDetailLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonBreadcrumb className="w-56" />

      {/* 머리 패널만 제목 줄 오른쪽에 배지·인쇄 버튼이 있어 Panel 틀을 그대로 쓴다 */}
      <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-rule bg-surface p-4 shadow-panel md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-8.5 w-48" />
        </div>
        {/* 사이트·기간·작성·승인 네 칸. 작성·승인은 계정과 시각이 두 줄로 내려가는 일이 많다 */}
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
        <Skeleton className="h-8.5 w-72 max-w-full" />
      </div>

      <SkeletonPanel titleClassName="w-28">
        {/* 검증 배지 한 줄 + 규칙 안내 한 줄 */}
        <Skeleton className="h-11" />
      </SkeletonPanel>

      {['findings', 'kpi'].map((section) => (
        <SkeletonPanel key={section} titleClassName="w-36">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </SkeletonPanel>
      ))}

      <SkeletonPanel titleClassName="w-44">
        <SkeletonTable rows={5} />
      </SkeletonPanel>

      <SkeletonPanel titleClassName="w-32">
        <Skeleton className="h-20" />
      </SkeletonPanel>
    </>
  );
}
