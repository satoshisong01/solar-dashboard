import Link from 'next/link';
import { keepWithinAxes } from '@/components/charts/series-window';
import { TimeseriesChart } from '@/components/charts/timeseries-chart';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { toneOfClass } from '@/lib/data/domains';
import { FINDING_SERIES_SPANS, type FindingSeries, type FindingSeriesSpan } from '@/lib/data/finding-series';
import { formatKstDateTime } from '@/lib/format';

const SPAN_CLASS =
  'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors border-rule bg-surface text-ink-2 hover:bg-sunken hover:text-ink ' +
  'aria-[current=true]:border-accent aria-[current=true]:bg-hydrogen-fill aria-[current=true]:text-ink';

type RawSeriesPanelProps = Readonly<{ series: FindingSeries; span: FindingSeriesSpan; basePath: string; exploreHref: string | null }>;

/** 관련 포인트 원시 시계열 (확대하면 /api/series로 재조회) + 에피소드·결측 구간 밴드 */
export function RawSeriesPanel({ series, span, basePath, exploreHref }: RawSeriesPanelProps) {
  const points = keepWithinAxes(series.points);
  return (
    <Panel
      title="원시 시계열"
      meta={`${formatKstDateTime(series.fromMs)} ~ ${formatKstDateTime(series.toMs)} KST · 탐지 창 끝 기준`}
      action={
        exploreHref && (
          <Link href={exploreHref} className="text-sm font-medium text-accent hover:underline">
            자산 상세에서 보기
          </Link>
        )
      }
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="원시 시계열 기간">
        {(Object.keys(FINDING_SERIES_SPANS) as FindingSeriesSpan[]).map((key) => (
          <Link key={key} href={`${basePath}?series=${key}#raw-series`} scroll={false} aria-current={key === span} className={SPAN_CLASS}>
            {FINDING_SERIES_SPANS[key].label}
          </Link>
        ))}
      </div>
      {series.payload === null || points.length === 0 ? (
        <EmptyNote>이 발견사항과 연결된 포인트가 없습니다</EmptyNote>
      ) : (
        <TimeseriesChart
          key={`${span}|${series.fromMs}`}
          points={points.map((point) => ({ id: point.id, label: `${point.assetCode} · ${point.metricName}`, unit: point.unit, tone: toneOfClass(point.classKey) }))}
          initial={series.payload}
          bands={series.bands}
          bandLabel={series.bandLabel ?? '구간'}
        />
      )}
    </Panel>
  );
}
