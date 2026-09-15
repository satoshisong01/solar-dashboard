'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { CurvePointView } from '@/lib/desk/scorecard';
import { formatNumber } from '@/lib/format';

function buildCurveOption(theme: ChartTheme, curve: readonly CurvePointView[], unit: string, minDetectable: number | null): EChartOption {
  const axisStyle = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } };
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 48, right: 16, top: 24, bottom: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.surface,
      borderColor: theme.rule,
      textStyle: { color: theme.ink, fontSize: 12 },
      formatter: (params: unknown) => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined;
        const point = curve[first?.dataIndex ?? -1];
        if (!point) return '';
        return `주입 ${formatNumber(point.magnitude, 3)} ${unit}<br/>탐지 ${point.detected}/${point.injections} (재현율 ${point.recall === null ? '—' : `${formatNumber(point.recall * 100, 0)}%`})<br/>지연 중앙값 ${point.medianDelayDays === null ? '—' : `${formatNumber(point.medianDelayDays, 1)}일`}`;
      },
    },
    xAxis: { type: 'category', name: `주입 크기 (${unit})`, nameLocation: 'middle', nameGap: 28, data: curve.map((p) => formatNumber(p.magnitude, 3)), ...axisStyle },
    yAxis: { type: 'value', name: '재현율', min: 0, max: 1, ...axisStyle, axisLabel: { color: theme.muted, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: { lineStyle: { color: theme.rule } } },
    series: [
      {
        type: 'line',
        name: '재현율',
        data: curve.map((p) => p.recall),
        color: theme.accent,
        symbolSize: 8,
        lineStyle: { width: 2 },
        markLine:
          minDetectable === null
            ? undefined
            : { silent: true, symbol: 'none', lineStyle: { color: theme.warn, type: 'dashed' }, label: { color: theme.warn, formatter: '최소 탐지 크기' }, data: [{ xAxis: formatNumber(minDetectable, 3) }] },
      },
    ],
  };
}

type Props = Readonly<{ detector: string; curve: readonly CurvePointView[]; unit: string; minDetectable: number | null }>;

/** 최소 탐지 크기 곡선: 주입 크기별 재현율 */
export function DetectionCurveChart({ detector, curve, unit, minDetectable }: Props) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildCurveOption(theme, curve, unit, minDetectable) : null), [theme, curve, unit, minDetectable]);
  return <EChart option={option} className="h-56 w-full" ariaLabel={`${detector} 최소 탐지 크기 곡선: 주입 크기별 재현율`} />;
}
