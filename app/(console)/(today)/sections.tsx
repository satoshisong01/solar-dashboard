import { TopFindingsPanel, WorkCountersPanel } from '@/components/today/finding-panels';
import { SafetyBanner } from '@/components/today/safety-banner';
import { SiteMapCard } from '@/components/today/site-map-card';
import { DataGapsPanel, EnergySummaryPanel, RevenuePanel } from '@/components/today/today-panels';
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

export async function CountersSection({ nowMs }: NowProps) {
  return <WorkCountersPanel counts={await getFindingWorkCounts(nowMs)} />;
}

export async function SiteMapSection({ nowMs }: NowProps) {
  return <SiteMapCard sites={await getSiteMapStatus(nowMs)} nowMs={nowMs} />;
}

export async function TopFindingsSection({ nowMs }: NowProps) {
  return <TopFindingsPanel rows={await listNewAndReopened(TOP_FINDINGS)} nowMs={nowMs} limit={TOP_FINDINGS} />;
}

export async function DataGapsSection({ nowMs }: NowProps) {
  return <DataGapsPanel gaps={await getDataGaps(nowMs)} nowMs={nowMs} />;
}

export async function RevenueSection({ nowMs }: NowProps) {
  return <RevenuePanel rows={await getMarketSummary(nowMs)} />;
}

export async function EnergySection({ nowMs }: NowProps) {
  return <EnergySummaryPanel rows={await getEnergySummary(nowMs)} />;
}
