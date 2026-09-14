import type { Metadata } from 'next';
import { RangeControls } from '@/components/charts/range-controls';
import { keepWithinAxes } from '@/components/charts/series-window';
import { TimeseriesChart } from '@/components/charts/timeseries-chart';
import { PageHeader } from '@/components/console/page-header';
import { explorePointLabel, type ExplorePoint } from '@/components/explore/explore-filter';
import { ExplorePicker } from '@/components/explore/explore-picker';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { toneOfClass } from '@/lib/data/domains';
import { getPoints } from '@/lib/data/points';
import { firstParam, parsePointIds, resolveRange, type SearchParamValue } from '@/lib/data/range';
import { getSeries } from '@/lib/data/series';
import { SERIES_LIMITS } from '@/lib/data/series-types';
import { getAssets, getEvents } from '@/lib/data/sites';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '탐색기' };

const BAND_EVENT_LIMIT = 200;

type ExplorePageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

export default async function ExplorePage({ searchParams }: ExplorePageProps) {
  await requireAdmin();
  const query = await searchParams;
  const nowMs = requestTimeMs();
  const range = resolveRange({ range: firstParam(query.range), from: firstParam(query.from), to: firstParam(query.to) }, nowMs);
  const [pointRows, assetRows] = await Promise.all([getPoints(), getAssets()]);

  const points: ExplorePoint[] = pointRows.map((point) => ({
    id: point.id,
    assetId: point.assetId,
    siteCode: point.siteCode,
    assetCode: point.assetCode,
    metricKey: point.metricKey,
    metricName: point.metricName,
    qualifier: point.qualifier,
    unit: point.unit,
    classKey: point.classKey,
  }));
  const requested = parsePointIds(firstParam(query.points), new Set(points.map((point) => point.id)));
  const selected = keepWithinAxes(requested.flatMap((id) => points.filter((point) => point.id === id)));
  const selectedIds = selected.map((point) => point.id);
  const metrics = [...new Map(points.map((point) => [point.metricKey, point.metricName])).entries()]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const [series, bandEvents] = await Promise.all([
    selectedIds.length > 0
      ? getSeries({ pointIds: selectedIds, fromMs: range.fromMs, toMs: range.toMs, maxPoints: SERIES_LIMITS.defaultMaxPoints })
      : null,
    getEvents({ assetIds: [...new Set(selected.map((point) => point.assetId))], fromMs: range.fromMs, toMs: range.toMs, limit: BAND_EVENT_LIMIT }),
  ]);

  return (
    <>
      <PageHeader title="탐색기" purpose="임의 포인트를 골라 원시 데이터 탐색" />
      <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Panel title="포인트 선택">
          <ExplorePicker
            assets={assetRows.map((asset) => ({
              id: asset.id,
              siteCode: asset.siteCode,
              parentId: asset.parentId,
              code: asset.code,
              name: asset.name,
              className: asset.className,
            }))}
            points={points}
            metrics={metrics}
            selectedIds={selectedIds}
            selection={range.selection}
          />
        </Panel>
        <Panel title="시계열" meta={`${formatKstDateTime(range.fromMs)} ~ ${formatKstDateTime(range.toMs)} KST`}>
          <RangeControls basePath="/explore" pointIds={selectedIds} selection={range.selection} fromMs={range.fromMs} toMs={range.toMs} />
          {series === null ? (
            <EmptyNote>왼쪽 트리에서 포인트를 고르면 차트가 표시됩니다</EmptyNote>
          ) : (
            <TimeseriesChart
              key={`${selectedIds.join(',')}|${range.fromMs}|${range.toMs}`}
              points={selected.map((point) => ({ id: point.id, label: explorePointLabel(point), unit: point.unit, tone: toneOfClass(point.classKey) }))}
              initial={series}
              events={bandEvents.map((event) => ({
                id: event.id,
                tsMs: event.tsMs,
                label: `${event.assetCode ?? event.sourceKey} ${event.code}`,
                severity: event.severity,
              }))}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
