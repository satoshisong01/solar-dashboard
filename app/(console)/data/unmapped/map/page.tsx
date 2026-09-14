import type { Metadata } from 'next';
import { MappingWorkspace } from '@/components/data/mapping-workspace';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';
import { listMetricDefs } from '@/lib/data/catalog';
import { getInboxTag } from '@/lib/data/ingest-status';
import { firstParam, parsePositiveIntParam, type SearchParamValue } from '@/lib/data/range';
import { getAssets } from '@/lib/data/sites';
import { SMALLINT_MAX } from '@/lib/forms/fields';

export const metadata: Metadata = { title: '태그 매핑' };

type MapPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function MapTagPage({ searchParams }: MapPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const parsedGatewayId = parsePositiveIntParam(firstParam(query.gateway) ?? '');
  const gatewayId = parsedGatewayId !== null && parsedGatewayId <= SMALLINT_MAX ? parsedGatewayId : null; // om.gateway.id는 smallint
  const sourceKey = firstParam(query.source);
  const tag = gatewayId !== null && sourceKey ? await getInboxTag(gatewayId, sourceKey) : null;
  const [assets, metrics] = tag && tag.mapped === null ? await Promise.all([getAssets({ siteId: tag.siteId }), listMetricDefs()]) : [[], []];

  return (
    <>
      <Breadcrumb items={[{ label: '데이터', href: '/data' }, { label: '미매핑 태그', href: '/data/unmapped' }, { label: '태그 매핑' }]} />
      <PageHeader title="태그 매핑" purpose="수신한 원본 태그를 설비·메트릭 포인트로 연결하고, 보존된 원본에서 과거 값을 재처리" />
      <MappingWorkspace
        tag={
          tag && {
            gatewayId: tag.gatewayId,
            gatewayCode: tag.gatewayCode,
            siteCode: tag.siteCode,
            sourceKey: tag.sourceKey,
            unit: tag.unit,
            firstSeenMs: tag.firstSeenMs,
            lastSeenMs: tag.lastSeenMs,
            sampleCount: tag.sampleCount,
            mapped: tag.mapped,
          }
        }
        assets={assets.map((asset) => ({ id: asset.id, code: asset.code, name: asset.name, className: asset.className }))}
        metrics={metrics.map((metric) => ({ key: metric.key, name: metric.nameKo, unit: metric.unit }))}
      />
    </>
  );
}
