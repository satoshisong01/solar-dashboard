import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { TopFindingsPanel, WorkCountersPanel } from '@/components/today/finding-panels';
import { SafetyBanner } from '@/components/today/safety-banner';
import { SiteMapCard } from '@/components/today/site-map-card';
import { DataGapsPanel, EnergySummaryPanel, RevenuePanel } from '@/components/today/today-panels';
import { requireAdmin } from '@/lib/auth/dal';
import { getFindingWorkCounts, listNewAndReopened } from '@/lib/data/findings';
import { requestTimeMs } from '@/lib/data/time';
import { getSiteMapStatus } from '@/lib/data/site-map';
import { getDataGaps, getEnergySummary, getMarketSummary, getSafetyBanner } from '@/lib/data/today';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '오늘' };

const TOP_FINDINGS = 10;

export default async function TodayPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const [safety, counts, topFindings, gaps, energy, market, mapSites] = await Promise.all([
    getSafetyBanner(),
    getFindingWorkCounts(nowMs),
    listNewAndReopened(TOP_FINDINGS),
    getDataGaps(nowMs),
    getEnergySummary(nowMs),
    getMarketSummary(nowMs),
    getSiteMapStatus(nowMs),
  ]);

  return (
    <>
      <PageHeader title="오늘" purpose="출근 후 5분 안에 할 일과 밤사이 변화 파악" guide={SCREEN_GUIDES.today} />
      <p className="-mt-3 text-xs text-muted">기준 시각 {formatKstDateTime(nowMs)} KST</p>
      <SafetyBanner banner={safety} />
      <WorkCountersPanel counts={counts} />
      <SiteMapCard sites={mapSites} nowMs={nowMs} />
      <TopFindingsPanel rows={topFindings} nowMs={nowMs} limit={TOP_FINDINGS} />
      <div className="grid gap-6 lg:grid-cols-2">
        <DataGapsPanel gaps={gaps} nowMs={nowMs} />
        <RevenuePanel rows={market} />
      </div>
      <EnergySummaryPanel rows={energy} />
    </>
  );
}
