'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { PvLossView, ResidualPoint, SharePoint } from '@/lib/chain/series';
import { formatNumber } from '@/lib/format';

const axisStyle = (theme: ChartTheme) => ({ nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } } });
const tooltipBase = (theme: ChartTheme) => ({ confine: true, backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 } });

/** 축 툴팁 한 줄: 계열 표시 + 이름 + 값 (글자는 잉크 색, 계열 색은 표시만) */
function axisLines(params: unknown, format: (value: number, seriesName: string) => string): string {
  const items = Array.isArray(params) ? (params as { axisValue?: string; seriesName?: string; value?: unknown; marker?: string }[]) : [];
  const head = items[0]?.axisValue ?? '';
  const rows = items.flatMap((item) => (typeof item.value === 'number' ? [`${item.marker ?? ''}${item.seriesName ?? ''}: ${format(item.value, item.seriesName ?? '')}`] : []));
  return [head, ...rows].join('<br/>');
}

function residualOption(theme: ChartTheme, points: readonly ResidualPoint[], thresholdPct: number): EChartOption {
  const days = points.map((p) => p.day);
  const color = (p: ResidualPoint) => (p.low ? theme.muted : theme.tones.hydrogen[0]);
  const band = theme.tones.hydrogen[1];
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    tooltip: {
      trigger: 'axis',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const day = Array.isArray(params) ? (params[0] as { axisValue?: string }).axisValue : undefined;
        const p = points.find((x) => x.day === day);
        if (!p) return '';
        const completeness = p.completeness === null ? '—' : `${formatNumber(p.completeness * 100, 1)}%`;
        return [p.day, `잔차 ${formatNumber(p.residualKg, 2)} kg`, `잔차율 ${p.residualPct === null ? '—' : `${formatNumber(p.residualPct, 2)}%`}`, `수소 원장 완결성 ${completeness}${p.low ? ' (기준 미만 · 탐지 제외)' : ''}`].join('<br/>');
      },
    },
    grid: [
      { left: 64, right: 16, top: 28, height: '34%' },
      { left: 64, right: 16, top: '58%', bottom: 48 },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: days, ...axisStyle(theme), axisLabel: { show: false } },
      { type: 'category', gridIndex: 1, data: days, ...axisStyle(theme) },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: '잔차 [kg]', ...axisStyle(theme), splitLine: { lineStyle: { color: theme.rule } } },
      { type: 'value', gridIndex: 1, name: '잔차율 [%]', ...axisStyle(theme), splitLine: { lineStyle: { color: theme.rule } } },
    ],
    series: [
      { type: 'bar', name: '잔차', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 14, data: points.map((p) => ({ value: p.residualKg, itemStyle: { color: color(p), borderRadius: 2 } })) },
      {
        type: 'bar',
        name: '잔차율',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 14,
        data: points.map((p) => ({ value: p.residualPct, itemStyle: { color: color(p), borderRadius: 2 } })),
        markArea: { silent: true, itemStyle: { color: band, opacity: 0.14 }, data: [[{ yAxis: -thresholdPct }, { yAxis: thresholdPct }]] },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: theme.muted, type: 'dashed', width: 1 },
          label: { color: theme.muted, formatter: `기준 ±${formatNumber(thresholdPct, 2)}%`, position: 'insideStartTop' },
          data: [{ yAxis: thresholdPct }, { yAxis: -thresholdPct }],
        },
      },
    ],
  };
}

export function ResidualChart({ points, thresholdPct }: Readonly<{ points: readonly ResidualPoint[]; thresholdPct: number }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? residualOption(theme, points, thresholdPct) : null), [theme, points, thresholdPct]);
  return <EChart option={option} className="h-80 w-full" ariaLabel={`수소 물질수지 잔차 일별 막대: 잔차 kg와 잔차율 %, 기준 ±${thresholdPct}% 밴드`} />;
}

function shareOption(theme: ChartTheme, points: readonly SharePoint[]): EChartOption {
  const series = [
    { name: '재생(태양광·ESS) 비율', color: theme.tones.solar[0], values: points.map((p) => p.renewableShare * 100) },
    { name: '계통 전력 비율', color: theme.tones.neutral[0], values: points.map((p) => p.gridShare * 100) },
  ];
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    legend: { top: 0, left: 0, textStyle: { color: theme.ink2 } },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), formatter: (params: unknown) => axisLines(params, (v) => `${formatNumber(v, 1)}%`) },
    grid: { left: 56, right: 24, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: points.map((p) => p.day), ...axisStyle(theme) },
    yAxis: { type: 'value', name: '%', min: 0, max: 100, ...axisStyle(theme), splitLine: { lineStyle: { color: theme.rule } } },
    series: series.map((s) => ({ type: 'line', name: s.name, data: s.values, color: s.color, lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 4, showSymbol: points.length <= 31 })),
  };
}

export function ShareTrendChart({ points }: Readonly<{ points: readonly SharePoint[] }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? shareOption(theme, points) : null), [theme, points]);
  return <EChart option={option} className="h-64 w-full" ariaLabel="전해조 입력 전력 중 재생·계통 비율 일별 추세" />;
}

function pvLossOption(theme: ChartTheme, view: PvLossView): EChartOption {
  const colorAt = (i: number, bucket: string) => (bucket === 'unexplained' ? theme.muted : (theme.series[i] ?? theme.muted));
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    legend: { top: 0, left: 0, textStyle: { color: theme.ink2 } },
    tooltip: {
      trigger: 'axis',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const text = axisLines(params, (v) => `${formatNumber(v, 1)} kWh`);
        const items = Array.isArray(params) ? (params as { value?: unknown }[]) : [];
        const total = items.reduce((sum, item) => sum + (typeof item.value === 'number' ? item.value : 0), 0);
        return items.some((item) => typeof item.value === 'number') ? `${text}<br/>합계 ${formatNumber(total, 1)} kWh` : `${text}<br/>분해 없음`;
      },
    },
    grid: { left: 64, right: 16, top: 64, bottom: 40 },
    xAxis: { type: 'category', data: [...view.days], ...axisStyle(theme) },
    yAxis: { type: 'value', name: 'kWh', ...axisStyle(theme), splitLine: { lineStyle: { color: theme.rule } } },
    series: view.series.map((s, i) => ({
      type: 'bar',
      name: s.label,
      stack: 'pv-loss',
      barMaxWidth: 18,
      data: [...s.values],
      color: colorAt(i, s.bucket),
      itemStyle: { borderColor: theme.surface, borderWidth: 1 },
    })),
  };
}

export function PvLossChart({ view }: Readonly<{ view: PvLossView }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? pvLossOption(theme, view) : null), [theme, view]);
  return <EChart option={option} className="h-80 w-full" ariaLabel="PV 미활용 원인 분해 일별 누적 막대 (출력제어·클리핑·정지·열 저감·ESS 만충·오염 추정·설명 안 됨)" />;
}
