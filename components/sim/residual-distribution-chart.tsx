'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { MassBalanceDistribution } from '@/lib/desk/scorecard-p3';
import { formatNumber } from '@/lib/format';

interface GateLine {
  readonly label: string;
  readonly valuePct: number;
}

function buildOption(theme: ChartTheme, dist: MassBalanceDistribution, gates: readonly GateLine[]): EChartOption {
  const bars = [
    ['중앙값', dist.medianPct],
    ['90퍼센타일', dist.p90Pct],
    ['95퍼센타일', dist.p95Pct],
    ['최대', dist.maxPct],
  ].flatMap(([label, value]) => (typeof value === 'number' ? [[label as string, value] as const] : []));
  const axis = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } };
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 96, right: 48, top: 16, bottom: 40 },
    tooltip: { trigger: 'axis', confine: true, backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 }, valueFormatter: (v) => (typeof v === 'number' ? `${formatNumber(v, 3)}%` : String(v)) },
    xAxis: { type: 'value', name: '|잔차율| [%]', nameLocation: 'middle', nameGap: 26, min: 0, ...axis, splitLine: { lineStyle: { color: theme.rule } } },
    yAxis: { type: 'category', data: bars.map(([label]) => label), inverse: true, ...axis },
    series: [
      {
        type: 'bar',
        name: '|잔차율|',
        barMaxWidth: 18,
        color: theme.tones.hydrogen[0],
        data: bars.map(([, value]) => value),
        label: { show: true, position: 'right', color: theme.ink, formatter: (p: unknown) => `${formatNumber(Number((p as { value?: unknown }).value), 3)}%` },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: theme.warn, type: 'dashed' }, label: { color: theme.warn, position: 'insideEndTop' }, data: gates.map((g) => ({ xAxis: g.valuePct, label: { formatter: g.label } })) },
      },
    ],
  };
}

/** 대조군 물질수지 |잔차율| 분포(중앙값·90·95퍼센타일·최대)와 게이트 기준선 */
export function ResidualDistributionChart({ distribution, gates }: Readonly<{ distribution: MassBalanceDistribution; gates: readonly GateLine[] }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? buildOption(theme, distribution, gates) : null), [theme, distribution, gates]);
  return <EChart option={option} className="h-52 w-full" ariaLabel="대조군 수소 물질수지 일별 잔차율 절댓값 분포와 게이트 기준" />;
}
