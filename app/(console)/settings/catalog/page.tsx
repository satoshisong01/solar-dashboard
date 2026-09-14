import { CircleCheck, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { AssetClassTable, MetricDefTable } from '@/components/settings/catalog-tables';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { listAssetClasses, listMetricDefs } from '@/lib/data/catalog';
import { firstParam, type SearchParamValue } from '@/lib/data/range';

export const metadata: Metadata = { title: '카탈로그' };

const SEARCH_MAX = 64;

type CatalogPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function CatalogPage({ searchParams }: CatalogPageProps) {
  await requireAdmin();
  const query = await searchParams;
  const search = (firstParam(query.q) ?? '').trim().slice(0, SEARCH_MAX);
  const saved = firstParam(query.saved) ?? null;
  const [metrics, classes] = await Promise.all([listMetricDefs(search), listAssetClasses()]);
  const savedExists = saved !== null && metrics.some((metric) => metric.key === saved);

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/catalog" />

      {savedExists && (
        <p role="status" className="flex items-center gap-2 rounded-md border border-ok/40 bg-ok-fill px-3 py-2 text-sm text-ok">
          <CircleCheck aria-hidden="true" className="size-4" />
          메트릭 <span className="font-mono">{saved}</span>을(를) 추가했습니다.
        </p>
      )}

      <Panel
        title="메트릭 정의"
        meta={`${metrics.length}개${search ? ` · "${search}" 검색` : ''}`}
        action={
          <Link href="/settings/catalog/metrics/new" className="inline-flex items-center gap-1 rounded-md border border-transparent bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:bg-accent/90">
            <Plus aria-hidden="true" className="size-4" />
            새 메트릭
          </Link>
        }
      >
        <form method="get" role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted">
            검색 (키·이름·물리량·별칭)
            <input type="search" name="q" defaultValue={search} maxLength={SEARCH_MAX} placeholder="예: temp, 전압, SunSpec" className="rounded-md border border-rule-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted" />
          </label>
          <button type="submit" className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-sunken hover:text-ink">
            검색
          </button>
          {search && (
            <Link href="/settings/catalog" className="px-2 py-1.5 text-sm text-ink-2 hover:underline">
              전체 보기
            </Link>
          )}
        </form>
        <MetricDefTable rows={metrics} highlightKey={savedExists ? saved : null} />
      </Panel>

      <Panel title="설비 종류" meta={`${classes.length}개 · 안전 이벤트 코드는 수신 즉시 안전 레인으로 기록됩니다`}>
        <AssetClassTable rows={classes} />
      </Panel>
    </>
  );
}
