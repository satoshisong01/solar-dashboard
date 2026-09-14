import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AssetLinks, AssetNameplate } from '@/components/assets/asset-info';
import { PointTable } from '@/components/assets/point-table';
import { PointPicker } from '@/components/charts/point-picker';
import { RangeControls } from '@/components/charts/range-controls';
import { keepWithinAxes } from '@/components/charts/series-window';
import { TimeseriesChart } from '@/components/charts/timeseries-chart';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { EventTimeline } from '@/components/events/event-timeline';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getAssetDetail } from '@/lib/data/assets';
import { toneOfClass } from '@/lib/data/domains';
import { getLatestSamples, getPoints, getQualitySummary, type PointInfo } from '@/lib/data/points';
import { decodeRouteParam, firstParam, parsePointIds, parsePositiveIntParam, resolveRange, type SearchParamValue } from '@/lib/data/range';
import { getSeries } from '@/lib/data/series';
import { SERIES_LIMITS } from '@/lib/data/series-types';
import { getEvents } from '@/lib/data/sites';
import { DAY_MS, requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';

const EVENT_LIMIT = 50;
const BAND_EVENT_LIMIT = 200;
/** 수집 API는 5분 넘게 미래인 샘플을 거부한다 */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

type AssetPageProps = Readonly<{
  params: Promise<{ siteCode: string; assetId: string }>;
  searchParams: Promise<Record<string, SearchParamValue>>;
}>;

export const metadata: Metadata = { title: '자산 상세' };

const pointLabel = (point: PointInfo) => (point.qualifier ? `${point.metricName} (${point.qualifier})` : point.metricName);

/** URL에 선택이 없으면 첫 gauge 포인트(없으면 첫 포인트)를 보여 준다 */
function defaultSelection(points: readonly PointInfo[]): number[] {
  const first = points.find((point) => point.valueKind === 'gauge') ?? points[0];
  return first ? [first.id] : [];
}

export default async function AssetPage({ params, searchParams }: AssetPageProps) {
  await requireAdmin();
  const [{ siteCode, assetId }, query] = await Promise.all([params, searchParams]);
  const code = decodeRouteParam(siteCode);
  const id = parsePositiveIntParam(assetId);
  const asset = code === null || id === null ? null : await getAssetDetail(code, id);
  if (!asset) notFound();

  const nowMs = requestTimeMs();
  const range = resolveRange({ range: firstParam(query.range), from: firstParam(query.from), to: firstParam(query.to) }, nowMs);
  const points = await getPoints({ assetId: asset.id });
  const requested = parsePointIds(firstParam(query.points), new Set(points.map((point) => point.id)));
  const initialIds = firstParam(query.points) === undefined ? defaultSelection(points) : requested;
  const selected = keepWithinAxes(initialIds.flatMap((pointId) => points.filter((point) => point.id === pointId)));
  const selectedIds = selected.map((point) => point.id);
  const pointIds = points.map((point) => point.id);

  const [latest, quality, events, bandEvents, series] = await Promise.all([
    getLatestSamples(pointIds),
    getQualitySummary(pointIds, nowMs - DAY_MS, nowMs + FUTURE_TOLERANCE_MS),
    getEvents({ assetIds: [asset.id], limit: EVENT_LIMIT }),
    getEvents({ assetIds: [asset.id], fromMs: range.fromMs, toMs: range.toMs, limit: BAND_EVENT_LIMIT }),
    selectedIds.length > 0
      ? getSeries({ pointIds: selectedIds, fromMs: range.fromMs, toMs: range.toMs, maxPoints: SERIES_LIMITS.defaultMaxPoints })
      : null,
  ]);
  const basePath = `/sites/${encodeURIComponent(asset.siteCode)}/assets/${asset.id}`;

  return (
    <>
      <Breadcrumb
        items={[
          { label: '사이트', href: '/sites' },
          { label: asset.siteCode, href: `/sites/${encodeURIComponent(asset.siteCode)}` },
          { label: asset.code },
        ]}
      />
      <PageHeader title={asset.name} purpose={`${asset.siteName} · ${asset.path}`} />

      <Panel title="명판">
        <AssetNameplate asset={asset} />
      </Panel>

      <Panel title="포인트" meta={`${points.length}개 · 기준 ${formatKstDateTime(nowMs)}`}>
        <PointTable points={points} latest={latest} quality={quality} nowMs={nowMs} />
      </Panel>

      <Panel title="시계열" meta={`${formatKstDateTime(range.fromMs)} ~ ${formatKstDateTime(range.toMs)} KST`}>
        {points.length === 0 ? (
          <EmptyNote>차트로 볼 포인트가 없습니다</EmptyNote>
        ) : (
          <div className="flex flex-col gap-4">
            <PointPicker
              points={points.map((point) => ({ id: point.id, label: pointLabel(point), unit: point.unit }))}
              selectedIds={selectedIds}
              basePath={basePath}
              selection={range.selection}
            />
            <RangeControls basePath={basePath} pointIds={selectedIds} selection={range.selection} fromMs={range.fromMs} toMs={range.toMs} />
            {series === null ? (
              <EmptyNote>차트에 표시할 포인트를 고르세요</EmptyNote>
            ) : (
              <TimeseriesChart
                key={`${selectedIds.join(',')}|${range.fromMs}|${range.toMs}`}
                points={selected.map((point) => ({ id: point.id, label: pointLabel(point), unit: point.unit, tone: toneOfClass(point.classKey) }))}
                initial={series}
                events={bandEvents.map((event) => ({ id: event.id, tsMs: event.tsMs, label: event.code, severity: event.severity }))}
              />
            )}
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="상위·하위 설비">
          <AssetLinks siteCode={asset.siteCode} parent={asset.parent} childAssets={asset.children} />
        </Panel>
        <Panel title="이 설비의 이벤트" meta={`최근 ${EVENT_LIMIT}건`}>
          <EventTimeline events={events} linkAssets={false} />
        </Panel>
      </div>
    </>
  );
}
