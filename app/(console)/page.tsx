import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SafetyBanner } from '@/components/today/safety-banner';
import { DataGapsPanel, EnergySummaryPanel, FindingsPlaceholder, RevenuePanel } from '@/components/today/today-panels';
import { requireAdmin } from '@/lib/auth/dal';
import { requestTimeMs } from '@/lib/data/time';
import { getDataGaps, getEnergySummary, getMarketSummary, getSafetyBanner } from '@/lib/data/today';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '오늘' };

export default async function TodayPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const [safety, gaps, energy, market] = await Promise.all([
    getSafetyBanner(),
    getDataGaps(nowMs),
    getEnergySummary(nowMs),
    getMarketSummary(nowMs),
  ]);

  return (
    <>
      <PageHeader title="오늘" purpose="출근 후 5분 안에 할 일과 밤사이 변화 파악" />
      <p className="-mt-3 text-xs text-muted">기준 시각 {formatKstDateTime(nowMs)} KST</p>
      <SafetyBanner banner={safety} />
      <div className="grid gap-6 lg:grid-cols-2">
        <DataGapsPanel gaps={gaps} nowMs={nowMs} />
        <RevenuePanel rows={market} />
      </div>
      <EnergySummaryPanel rows={energy} />
      <FindingsPlaceholder />
    </>
  );
}
