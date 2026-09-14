import type { Metadata } from 'next';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { MetricDefForm, type MetricFormValues } from '@/components/settings/metric-def-form';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '메트릭 추가' };

const EMPTY: MetricFormValues = {
  key: '',
  nameKo: '',
  quantity: '',
  unit: '',
  valueKind: 'gauge',
  rollup: 'avg',
  hardMin: '',
  hardMax: '',
  expectedMin: '',
  expectedMax: '',
  flatlineMaxS: '',
  aliases: '',
};

export default async function NewMetricPage() {
  await requireAdmin();

  return (
    <>
      <Breadcrumb items={[{ label: '설정', href: '/settings' }, { label: '카탈로그', href: '/settings/catalog' }, { label: '메트릭 추가' }]} />
      <PageHeader title="메트릭 추가" purpose="스키마를 바꾸지 않고 수집할 메트릭을 등록합니다 (om.metric_def INSERT)" />
      <Panel title="메트릭 정의">
        <MetricDefForm mode="create" initial={EMPTY} />
      </Panel>
    </>
  );
}
