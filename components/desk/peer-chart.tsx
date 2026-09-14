'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { PvPeerDay } from '@/lib/desk/evidence-types';

function buildPeerOption(theme: ChartTheme, days: readonly PvPeerDay[], assetLabel: string): EChartOption {
  const axisStyle = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } };
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 56, right: 24, top: 64, bottom: 40 },
    legend: { top: 0, left: 0, textStyle: { color: theme.ink2 } },
    tooltip: { trigger: 'axis', backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 } },
    xAxis: { type: 'category', data: days.map((d) => d.day.slice(5)), ...axisStyle },
    yAxis: { type: 'value', name: 'kWh/kWp', scale: true, ...axisStyle, splitLine: { lineStyle: { color: theme.rule } } },
    series: [
      { type: 'line', name: '동종 중앙값', data: days.map((d) => d.peerMedian), color: theme.muted, lineStyle: { type: 'dashed', width: 2 }, symbol: 'none' },
      {
        type: 'line',
        name: assetLabel,
        data: days.map((d) => ({ value: d.kwhPerKwp, symbol: d.flagged ? 'diamond' : 'circle', symbolSize: d.flagged ? 10 : 6, itemStyle: { color: d.flagged ? theme.crit : theme.accent } })),
        color: theme.accent,
        lineStyle: { width: 2 },
      },
    ],
  };
}

type PeerChartProps = Readonly<{ days: readonly PvPeerDay[]; assetLabel: string }>;

/** 인버터 일 kWh/kWp vs 같은 사이트 동종 중앙값. 낮다고 판정한 날은 마름모(위험 색)로 표시 */
export function PeerChart({ days, assetLabel }: PeerChartProps) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildPeerOption(theme, days, assetLabel) : null), [theme, days, assetLabel]);
  return <EChart option={option} className="h-64 w-full" ariaLabel={`동종 비교 차트: ${assetLabel} 일 kWh/kWp와 동종 중앙값`} />;
}
