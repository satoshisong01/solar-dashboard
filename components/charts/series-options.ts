// 시계열 차트 ECharts 옵션 조립. 클라이언트 전용(테마 토큰을 받는다)이지만 DOM에 접근하지 않는다.
import type { MarkAreaComponentOption } from 'echarts/components';
import type { ChartTone } from '@/lib/data/domains';
import type { SeriesPayload } from '@/lib/data/series-types';
import type { EventSeverity } from '@/lib/data/severity';
import { formatDuration, formatKstDateTime, formatNumber } from '@/lib/format';
import type { ChartTheme } from './chart-theme';
import type { EChartOption } from './echart';
import { assignAxes } from './series-window';

export interface ChartPointMeta {
  readonly id: number;
  /** 범례·툴팁 이름 (설비 코드 · 메트릭 이름) */
  readonly label: string;
  readonly unit: string;
  readonly tone: ChartTone;
}

export interface ChartEventMark {
  readonly id: string;
  readonly tsMs: number;
  readonly label: string;
  readonly severity: EventSeverity;
}

/** 시작~끝이 있는 구간 (에피소드·결측 등) */
export interface ChartBandMark {
  readonly id: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
}

type MarkAreaData = NonNullable<MarkAreaComponentOption['data']>[number];

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const seriesName = (point: ChartPointMeta) => (point.unit ? `${point.label} (${point.unit})` : point.label);

const LINE_TYPES = ['solid', 'dashed', 'dotted'] as const;

/**
 * 색은 설비 도메인 계열(태양광 앰버·수소 틸·중립)을 따른다. 같은 계열이 여럿이면 먼저 선 모양(실선·파선·점선)으로,
 * 그다음 옅은 색으로 구분한다. 범례·툴팁에 이름이 함께 나오므로 색만으로 구분하지 않는다.
 */
function lineStyleFor(theme: ChartTheme, tone: ChartTone, indexInTone: number) {
  const [main, edge] = theme.tones[tone];
  return {
    color: Math.floor(indexInTone / LINE_TYPES.length) % 2 === 0 ? main : edge,
    type: LINE_TYPES[indexInTone % LINE_TYPES.length],
  };
}

function eventColor(theme: ChartTheme, severity: EventSeverity): string {
  if (severity === 'critical') return theme.crit;
  if (severity === 'major') return theme.warn;
  return theme.muted;
}

function axisLabel(ms: number, spanMs: number): string {
  const text = formatKstDateTime(ms); // YYYY-MM-DD HH:mm
  return spanMs <= 36 * 3_600_000 ? text.slice(11) : spanMs <= 10 * 86_400_000 ? `${text.slice(5, 10)} ${text.slice(11)}` : text.slice(5, 10);
}

interface TooltipParam {
  readonly marker?: unknown;
  readonly seriesName?: string;
  readonly value?: unknown;
}

function tooltipHtml(params: unknown, bucketSeconds: number): string {
  const list = (Array.isArray(params) ? params : [params]) as TooltipParam[];
  const first = list[0]?.value;
  if (!Array.isArray(first) || typeof first[0] !== 'number') return '';
  const header = `${formatKstDateTime(first[0])} · ${formatDuration(bucketSeconds * 1_000)} 구간`;
  const lines = list.map((param) => {
    const value = Array.isArray(param.value) ? param.value : [];
    const [, min, avg, max] = value as (number | null)[];
    const marker = typeof param.marker === 'string' ? param.marker : '';
    return `<div>${marker}${escapeHtml(param.seriesName ?? '')}: <b>${formatNumber(avg ?? null, 3)}</b> <span style="opacity:.75">(최소 ${formatNumber(min ?? null, 3)} · 최대 ${formatNumber(max ?? null, 3)})</span></div>`;
  });
  return [`<div style="margin-bottom:4px">${escapeHtml(header)}</div>`, ...lines].join('');
}

interface BuildOptions {
  readonly theme: ChartTheme;
  readonly points: readonly ChartPointMeta[];
  readonly data: SeriesPayload;
  readonly events: readonly ChartEventMark[];
  readonly bands?: readonly ChartBandMark[];
}

export function buildSeriesOption({ theme, points, data, events, bands = [] }: BuildOptions): EChartOption {
  const spanMs = data.toMs - data.fromMs;
  const { axisUnits, axisIndexes } = assignAxes(points.map((point) => point.unit));
  const rowsById = new Map(data.series.map((series) => [series.pointId, series.rows]));
  const bandWidthMs = Math.max(data.bucketSeconds * 1_000, spanMs * 0.004);

  const drawn = points.flatMap((point, index) => {
    const axis = axisIndexes[index];
    return axis === null ? [] : [{ point, axis, indexInTone: points.slice(0, index).filter((p) => p.tone === point.tone).length }];
  });

  const series = drawn.map(({ point, axis, indexInTone }, order) => {
    const style = lineStyleFor(theme, point.tone, indexInTone);
    const rows = rowsById.get(point.id) ?? [];
    return {
      id: `point-${point.id}`,
      name: seriesName(point),
      type: 'line' as const,
      yAxisIndex: axis,
      color: style.color,
      lineStyle: { width: 2, type: style.type },
      showSymbol: rows.length <= 60,
      symbolSize: 6,
      connectNulls: false,
      data: rows.map((row) => [...row]),
      encode: { x: 0, y: 2 },
      ...(order === 0 && events.length + bands.length > 0
        ? {
            markArea: {
              silent: false,
              label: { show: false, color: theme.ink2, fontSize: 11 },
              emphasis: { label: { show: true, position: 'insideTop' as const } },
              data: [
                ...bands.map((band): MarkAreaData => [
                  { name: band.label, xAxis: band.fromMs, itemStyle: { color: theme.accent, opacity: 0.12 } },
                  { xAxis: Math.max(band.toMs, band.fromMs + bandWidthMs / 4) },
                ]),
                ...events.map((event): MarkAreaData => [
                  { name: event.label, xAxis: event.tsMs, itemStyle: { color: eventColor(theme, event.severity), opacity: 0.28 } },
                  { xAxis: event.tsMs + bandWidthMs },
                ]),
              ],
            },
          }
        : {}),
    };
  });

  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 16, right: 16, top: drawn.length > 1 ? 56 : 32, bottom: 64 },
    legend: { show: drawn.length > 1, top: 0, left: 0, type: 'plain', textStyle: { color: theme.ink2 }, itemWidth: 18 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.surface,
      borderColor: theme.rule,
      textStyle: { color: theme.ink, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: theme.muted } },
      formatter: (params: unknown) => tooltipHtml(params, data.bucketSeconds),
    },
    xAxis: {
      type: 'time',
      min: data.fromMs,
      max: data.toMs,
      axisLine: { lineStyle: { color: theme.rule } },
      axisLabel: { color: theme.muted, hideOverlap: true, formatter: (value: number) => axisLabel(value, spanMs) },
      splitLine: { show: false },
    },
    yAxis: axisUnits.map((unit, index) => ({
      type: 'value' as const,
      name: unit || '값',
      position: index === 0 ? ('left' as const) : ('right' as const),
      scale: true,
      nameTextStyle: { color: theme.muted },
      axisLabel: { color: theme.muted },
      axisLine: { show: false },
      splitLine: { show: index === 0, lineStyle: { color: theme.rule } },
    })),
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      {
        type: 'slider',
        xAxisIndex: 0,
        bottom: 8,
        height: 24,
        borderColor: theme.rule,
        fillerColor: `${theme.accent}22`,
        textStyle: { color: theme.muted },
        labelFormatter: (value: number) => axisLabel(value, spanMs),
      },
    ],
    series,
  };
}
