'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import { trendBand, type TrendView } from '@/lib/desk/trend';
import { formatKstDate, formatNumber } from '@/lib/format';

const xLabel = (trend: TrendView, value: number): string => (trend.xKind === 'time' ? formatKstDate(value).slice(5) : formatNumber(value, 0));
const xText = (trend: TrendView, value: number): string => (trend.xKind === 'time' ? formatKstDate(value) : `${formatNumber(value, 0)} h`);

function changeMarkLine(theme: ChartTheme, trend: TrendView) {
  if (trend.changeStart === null) return {};
  return {
    markLine: {
      silent: true,
      symbol: 'none',
      lineStyle: { color: theme.warn, type: 'dashed' as const, width: 1.5 },
      label: { color: theme.warn, formatter: 'CUSUM 변화 시작', position: 'end' as const },
      data: [{ xAxis: trend.changeStart }],
    },
  };
}

function buildTrendOption(theme: ChartTheme, trend: TrendView): EChartOption {
  const band = trendBand(trend);
  const axisStyle = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } };
  const bandSeries = band
    ? [
        // 음수 값(잔차)도 쌓이도록 stackStrategy 'all' (기본 samesign은 부호가 다르면 쌓지 않는다)
        { type: 'line' as const, name: '기울기 95% CI 하한', color: theme.accent, data: band.lower.map(([x, y]) => [x, y]), stack: 'ci', stackStrategy: 'all' as const, symbol: 'none', silent: true, lineStyle: { opacity: 0 }, tooltip: { show: false } },
        {
          type: 'line' as const,
          name: '기울기 95% CI',
          color: theme.accent,
          data: band.upper.map(([x, y], i) => [x, y - (band.lower[i]?.[1] ?? y)]),
          stack: 'ci',
          stackStrategy: 'all' as const,
          symbol: 'none',
          silent: true,
          lineStyle: { opacity: 0 },
          areaStyle: { color: theme.accent, opacity: 0.14 },
          tooltip: { show: false },
        },
      ]
    : [];
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 56, right: 24, top: 72, bottom: 48 },
    legend: { top: 0, left: 0, textStyle: { color: theme.ink2 }, data: ['측정', 'Theil–Sen 추세', ...(band ? ['기울기 95% CI'] : [])] },
    tooltip: { trigger: 'item', backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 } },
    xAxis: {
      type: 'value',
      name: trend.xKind === 'time' ? '날짜 (KST)' : '누적 운전시간 (h)',
      nameLocation: 'middle',
      nameGap: 28,
      scale: true,
      ...axisStyle,
      axisLabel: { color: theme.muted, hideOverlap: true, formatter: (value: number) => xLabel(trend, value) },
      splitLine: { show: false },
    },
    yAxis: { type: 'value', name: trend.yName, scale: true, ...axisStyle, splitLine: { lineStyle: { color: theme.rule } } },
    series: [
      ...bandSeries,
      {
        type: 'scatter',
        name: '측정',
        data: trend.points.map(([x, y]) => [x, y]),
        symbolSize: 5,
        color: theme.muted,
        tooltip: { formatter: (params: unknown) => {
          const value = (params as { value?: unknown }).value;
          return Array.isArray(value) ? `${xText(trend, Number(value[0]))}: ${formatNumber(Number(value[1]), 3)}` : '';
        } },
        ...changeMarkLine(theme, trend),
      },
      ...(trend.line ? [{ type: 'line' as const, name: 'Theil–Sen 추세', data: trend.line.map(([x, y]) => [x, y]), symbol: 'none', color: theme.accent, lineStyle: { width: 2 } }] : []),
    ],
  };
}

type TrendChartProps = Readonly<{ trend: TrendView; label: string }>;

/** 추세 산점도: 측정점 + Theil–Sen 선 + 기울기 95% CI 밴드 + CUSUM 변화 시작 표시 */
export function TrendChart({ trend, label }: TrendChartProps) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildTrendOption(theme, trend) : null), [theme, trend]);
  return <EChart option={option} className="h-72 w-full md:h-80" ariaLabel={`${label} 추세 산점도`} />;
}
