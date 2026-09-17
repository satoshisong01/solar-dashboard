import { TopFindingsPanel, WorkCountersPanel } from '@/components/today/finding-panels';
import { SafetyBanner } from '@/components/today/safety-banner';
import { SiteMapCard } from '@/components/today/site-map-card';
import { DataGapsPanel, EnergySummaryPanel, RevenuePanel } from '@/components/today/today-panels';
import { Skeleton, SkeletonCards, SkeletonPanel, SkeletonTable } from '@/components/ui/skeleton';
import { getFindingWorkCounts, listNewAndReopened } from '@/lib/data/findings';
import { getSiteMapStatus } from '@/lib/data/site-map';
import { getDataGaps, getEnergySummary, getMarketSummary, getSafetyBanner } from '@/lib/data/today';

/**
 * 대시보드 화면의 영역별 조회와 그 자리 골격.
 * 영역마다 Suspense 경계를 두므로(page.tsx) 조회가 끝난 영역부터 채워진다.
 * 골격은 loading.tsx와 Suspense fallback이 함께 쓴다 — 두 곳이 어긋나지 않게 여기 한 곳에만 둔다.
 */

export const TOP_FINDINGS = 10;

type NowProps = Readonly<{ nowMs: number }>;

export async function SafetySection() {
  return <SafetyBanner banner={await getSafetyBanner()} />;
}

/** 미확인 안전 이벤트가 없을 때의 한 줄 안내 높이. 열린 안전 발견사항 구역은 있을 때만 나오므로 자리를 잡아 두지 않는다 */
export function SafetySkeleton() {
  return <Skeleton className="h-10.5" />;
}

export async function CountersSection({ nowMs }: NowProps) {
  return <WorkCountersPanel counts={await getFindingWorkCounts(nowMs)} />;
}

export function CountersSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-16">
      <SkeletonCards count={5} className="grid-cols-2 lg:grid-cols-5" />
    </SkeletonPanel>
  );
}

export async function SiteMapSection({ nowMs }: NowProps) {
  return <SiteMapCard sites={await getSiteMapStatus(nowMs)} nowMs={nowMs} />;
}

export function SiteMapSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-28">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-56 sm:h-72" />
      </div>
    </SkeletonPanel>
  );
}

export async function TopFindingsSection({ nowMs }: NowProps) {
  return <TopFindingsPanel rows={await listNewAndReopened(TOP_FINDINGS)} nowMs={nowMs} limit={TOP_FINDINGS} />;
}

export function TopFindingsSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-44">
      <SkeletonTable rows={6} />
    </SkeletonPanel>
  );
}

export async function DataGapsSection({ nowMs }: NowProps) {
  return <DataGapsPanel gaps={await getDataGaps(nowMs)} nowMs={nowMs} />;
}

export function DataGapsSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-28">
      <SkeletonTable rows={3} />
    </SkeletonPanel>
  );
}

export async function RevenueSection({ nowMs }: NowProps) {
  return <RevenuePanel rows={await getMarketSummary(nowMs)} />;
}

export function RevenueSkeleton() {
  return (
    <SkeletonPanel titleClassName="w-24">
      <SkeletonTable rows={3} />
    </SkeletonPanel>
  );
}

export async function EnergySection({ nowMs }: NowProps) {
  return <EnergySummaryPanel rows={await getEnergySummary(nowMs)} />;
}

export function EnergySkeleton() {
  return (
    <SkeletonPanel titleClassName="w-52">
      <SkeletonTable rows={5} />
    </SkeletonPanel>
  );
}
