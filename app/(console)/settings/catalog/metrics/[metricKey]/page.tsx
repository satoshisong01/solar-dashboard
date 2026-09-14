import { TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { MetricDefForm, type MetricFormValues } from '@/components/settings/metric-def-form';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getMetricDef, type MetricDefRow } from '@/lib/data/catalog';
import { decodeRouteParam } from '@/lib/data/range';

export const metadata: Metadata = { title: '메트릭 수정' };

type MetricPageProps = Readonly<{ params: Promise<{ metricKey: string }> }>;

const text = (value: number | null) => (value === null ? '' : String(value));

function toFormValues(metric: MetricDefRow): MetricFormValues {
  return {
    key: metric.key,
    nameKo: metric.nameKo,
    quantity: metric.quantity,
    unit: metric.unit,
    valueKind: metric.valueKind,
    rollup: metric.rollup,
    hardMin: text(metric.hardMin),
    hardMax: text(metric.hardMax),
    expectedMin: text(metric.expectedMin),
    expectedMax: text(metric.expectedMax),
    flatlineMaxS: text(metric.flatlineMaxS),
    aliases: metric.aliases.join('\n'),
  };
}

export default async function EditMetricPage({ params }: MetricPageProps) {
  await requireAdmin();
  const { metricKey } = await params;
  const key = decodeRouteParam(metricKey);
  const metric = key === null ? null : await getMetricDef(key);
  if (!metric) notFound();

  return (
    <>
      <Breadcrumb items={[{ label: '설정', href: '/settings' }, { label: '카탈로그', href: '/settings/catalog' }, { label: metric.key }]} />
      <PageHeader title={metric.nameKo} purpose={`메트릭 정의 수정 · ${metric.key}`} />
      {metric.pointCount > 0 && (
        <p role="note" className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-fill px-3 py-2 text-sm text-ink">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
          포인트 {metric.pointCount}개가 이 메트릭을 씁니다. 단위·값 종류를 바꿔도 이미 저장된 값은 변환되지 않고, 물리 범위는 이후 수신분의 범위 밖 판정에만 쓰입니다.
        </p>
      )}
      <Panel title="메트릭 정의">
        <MetricDefForm mode="edit" initial={toFormValues(metric)} />
      </Panel>
    </>
  );
}
