import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AssetTree } from '@/components/assets/asset-tree';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { EventTimeline } from '@/components/events/event-timeline';
import { GatewayTable, SiteKpiCards } from '@/components/sites/site-panels';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { buildAssetTree } from '@/lib/data/asset-tree';
import { getSiteTodayKpis } from '@/lib/data/energy';
import { decodeRouteParam } from '@/lib/data/range';
import { SITE_LAYOUT_LABELS, getAssets, getEvents, getSiteByCode, getSiteGateways } from '@/lib/data/sites';
import { requestTimeMs, yesterdayAndToday } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';

const TIMELINE_LIMIT = 50;

type SitePageProps = Readonly<{ params: Promise<{ siteCode: string }> }>;

export async function generateMetadata({ params }: SitePageProps): Promise<Metadata> {
  const { siteCode } = await params;
  return { title: decodeRouteParam(siteCode) ?? '사이트' };
}

export default async function SitePage({ params }: SitePageProps) {
  await requireAdmin();
  const { siteCode } = await params;
  const code = decodeRouteParam(siteCode);
  const site = code === null ? null : await getSiteByCode(code);
  if (!site) notFound();

  const nowMs = requestTimeMs();
  const { today } = yesterdayAndToday(nowMs);
  const [kpis, assets, events, gateways] = await Promise.all([
    getSiteTodayKpis(site.id, today),
    getAssets({ siteId: site.id }),
    getEvents({ siteId: site.id, limit: TIMELINE_LIMIT }),
    getSiteGateways(site.id),
  ]);
  const tree = buildAssetTree(assets);
  const layout = site.layout ? (SITE_LAYOUT_LABELS[site.layout] ?? site.layout) : null;

  return (
    <>
      <Breadcrumb items={[{ label: '사이트', href: '/sites' }, { label: site.code }]} />
      <PageHeader
        title={`${site.code} · ${site.name}`}
        purpose={[layout, site.simulated ? '가상 사이트' : null, site.controlGroup ? '고장 없는 대조군' : null].filter(Boolean).join(' · ') || '사이트 상세'}
      />

      <Panel title="오늘 KPI" meta={`KST 0시 ~ ${formatKstDateTime(nowMs)}`}>
        <SiteKpiCards kpis={kpis} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="설비 트리" meta={`${assets.length}개`}>
          {tree.length === 0 ? <EmptyNote>등록된 설비가 없습니다</EmptyNote> : <AssetTree nodes={tree} siteCode={site.code} />}
        </Panel>
        <Panel title="이벤트 타임라인" meta={`최근 ${TIMELINE_LIMIT}건`}>
          <div role="region" aria-label="이벤트 타임라인 목록" tabIndex={0} className="max-h-[36rem] overflow-y-auto pr-1">
            <EventTimeline events={events} />
          </div>
        </Panel>
      </div>

      <Panel title="게이트웨이 상태">
        <GatewayTable gateways={gateways} nowMs={nowMs} />
      </Panel>
    </>
  );
}
