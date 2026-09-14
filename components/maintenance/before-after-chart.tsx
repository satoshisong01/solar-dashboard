'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { BinPair } from '@/lib/maintenance/bin-labels';

function buildOption(theme: ChartTheme, pairs: readonly BinPair[], unit: string): EChartOption {
  const axisStyle = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } };
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 64, right: 16, top: 56, bottom: 56 },
    legend: { top: 0, right: 0, textStyle: { color: theme.ink2 } },
    tooltip: { trigger: 'axis', backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 } },
    xAxis: { type: 'category', data: pairs.map((p) => p.label), ...axisStyle, axisLabel: { color: theme.muted, interval: 0, width: 120, overflow: 'break' } },
    yAxis: { type: 'value', name: unit, scale: true, ...axisStyle, splitLine: { lineStyle: { color: theme.rule } } },
    series: [
      { type: 'bar', name: '조치 전 중앙값', data: pairs.map((p) => p.beforeMedian), color: theme.muted },
      { type: 'bar', name: '안정화 후 중앙값', data: pairs.map((p) => p.afterMedian), color: theme.accent },
    ],
  };
}

type Props = Readonly<{ pairs: readonly BinPair[]; unit: string; metricLabel: string }>;

/** 조치 전후 같은 조건 bin 중앙값 비교 */
export function BeforeAfterChart({ pairs, unit, metricLabel }: Props) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildOption(theme, pairs, unit) : null), [theme, pairs, unit]);
  return <EChart option={option} className="h-64 w-full" ariaLabel={`조치 전후 비교 차트: ${metricLabel} bin별 중앙값`} />;
}
