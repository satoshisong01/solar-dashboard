'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { ThermalEvidence } from '@/lib/desk/p3-evidence-types';
import type { ThermalBinSeries } from '@/lib/desk/p3-view';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';
import { axisStyle, baseOption, splitLine, tooltipBase } from './chart-style';

function binsOption(theme: ChartTheme, series: readonly ThermalBinSeries[]): EChartOption {
  return {
    ...baseOption(theme),
    grid: { left: 56, right: 24, top: 64, bottom: 40 },
    tooltip: {
      trigger: 'item',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const item = params as { seriesName?: string; value?: unknown };
        return Array.isArray(item.value) ? `${formatKstDate(Number(item.value[0]))} · ${item.seriesName ?? ''}<br/>저감 ${formatNumber(Number(item.value[1]), 2)} h` : '';
      },
    },
    xAxis: { type: 'time', ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDate(v).slice(5) } },
    yAxis: { type: 'value', name: '일 저감 시간 [h]', min: 0, ...axisStyle(theme), splitLine: splitLine(theme) },
    series: series.map((s, i) => ({ type: 'bar', name: s.label, barGap: '-100%', barMaxWidth: 12, data: s.points.map(([x, y]) => [x, y]), color: s.binC === null ? theme.muted : (theme.series[i % theme.series.length] ?? theme.muted), itemStyle: { borderColor: theme.surface, borderWidth: 1 } })),
  };
}

/** 최근 기간 일별 저감 시간, 일 최고 외기 bin으로 색 구분 (같은 외기에서 저감이 늘면 냉각 계통 의심). 시간 축 stack은 x가 달라도 인덱스끼리 쌓으므로 쓰지 않고 겹쳐 그린다(날마다 한 계열에만 값이 있다) */
export function DerateDaysChart({ series }: Readonly<{ series: readonly ThermalBinSeries[] }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? binsOption(theme, series) : null), [theme, series]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="일별 인버터 열 저감 시간 막대, 일 최고 외기 온도 구간별 색" />;
}

type Representative = NonNullable<ThermalEvidence['representativeDay']>;

function dayOption(theme: ChartTheme, day: Representative, hotC: number | null): EChartOption {
  const pick = (value: (p: Representative['points'][number]) => number | null) => day.points.flatMap((p) => (value(p) === null ? [] : [[p.ts, value(p) as number]]));
  const heatColor = theme.series[1] ?? theme.warn;
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 64, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), valueFormatter: (value) => (typeof value === 'number' ? formatNumber(value, 3) : String(value)) },
    xAxis: { type: 'time', ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDateTime(v).slice(11) } },
    yAxis: [
      { type: 'value', name: `출력 [${day.unit}]`, min: 0, ...axisStyle(theme), splitLine: splitLine(theme) },
      { type: 'value', name: '방열판 [°C]', scale: true, position: 'right', ...axisStyle(theme), splitLine: { show: false } },
    ],
    series: [
      { type: 'line', name: '이 인버터', yAxisIndex: 0, data: pick((p) => p.own), color: theme.accent, showSymbol: false, lineStyle: { width: 2 } },
      { type: 'line', name: '동종 중앙값', yAxisIndex: 0, data: pick((p) => p.peer), color: theme.muted, showSymbol: false, lineStyle: { width: 2, type: 'dashed' } },
      {
        type: 'line',
        name: '방열판 온도',
        yAxisIndex: 1,
        data: pick((p) => p.heatsinkC),
        color: heatColor,
        showSymbol: false,
        lineStyle: { width: 1.5 },
        markLine: hotC === null ? undefined : { silent: true, symbol: 'none', lineStyle: { color: theme.crit, type: 'dashed' }, label: { color: theme.crit, position: 'insideStartTop', formatter: `저감 판정 ${formatNumber(hotC, 0)} °C` }, data: [{ yAxis: hotC }] },
      },
    ],
  };
}

/** 대표일(저감 시간 최대): 이 인버터·동종 중앙값 출력과 방열판 온도 겹침 */
export function RepresentativeDayChart({ day, hotC }: Readonly<{ day: Representative; hotC: number | null }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? dayOption(theme, day, hotC) : null), [theme, day, hotC]);
  return <EChart option={option} className="h-72 w-full" ariaLabel={`대표일 ${day.date} 인버터 출력·동종 중앙값·방열판 온도`} />;
}
