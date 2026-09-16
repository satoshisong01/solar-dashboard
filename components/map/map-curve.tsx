'use client';

import { useMemo } from 'react';
import { useChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import { curveHasData, type CurvePoint } from '@/lib/data/map-kpi';
import { formatKstDateTime, formatNumber } from '@/lib/format';

/** 'HH:MM' (KST) */
const hourLabel = (ms: number): string => formatKstDateTime(ms).slice(11, 16);

type Props = Readonly<{ curve: readonly CurvePoint[]; label: string; unit: string; tone: 'solar' | 'hydrogen' }>;

/** 오늘 시간대별 발전량 면적 그래프. 값이 하나도 없으면 빈 상태 문구를 대신 보인다 */
export function MapCurve({ curve, label, unit, tone }: Props) {
  const theme = useChartTheme();

  const option = useMemo((): EChartOption | null => {
    if (theme === null) return null;
    const [main] = theme.tones[tone];
    return {
      grid: { left: 2, right: 6, top: 8, bottom: 2, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: theme.surface,
        borderColor: theme.rule,
        textStyle: { color: theme.ink, fontSize: 11 },
        valueFormatter: (value) => `${formatNumber(typeof value === 'number' ? value : null, 1)} ${unit}`,
      },
      xAxis: {
        type: 'category',
        data: curve.map((point) => hourLabel(point.hourMs)),
        boundaryGap: false,
        axisLine: { lineStyle: { color: theme.rule } },
        axisTick: { show: false },
        axisLabel: { color: theme.muted, fontSize: 10, interval: Math.max(0, Math.ceil(curve.length / 6) - 1) },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: theme.rule } },
        axisLabel: { color: theme.muted, fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          name: label,
          data: curve.map((point) => point.value),
          smooth: true,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: main, width: 2 },
          itemStyle: { color: main },
          areaStyle: { color: main, opacity: 0.25 },
        },
      ],
    };
  }, [curve, label, theme, tone, unit]);

  if (!curveHasData(curve)) {
    return <p className="rounded-md border border-dashed border-rule-strong px-3 py-6 text-center text-xs text-muted">오늘 받은 데이터가 없습니다</p>;
  }
  return <EChart option={option} ariaLabel={`${label} (오늘, ${unit})`} className="h-32 w-full" />;
}
