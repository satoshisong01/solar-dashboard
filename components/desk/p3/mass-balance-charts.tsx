'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { MassBalanceEvidence } from '@/lib/desk/p3-evidence-types';
import { formatNumber } from '@/lib/format';
import { axisStyle, baseOption, splitLine, tooltipBase } from './chart-style';

type Days = MassBalanceEvidence['days'];

/** 축 툴팁: 날짜 + 계열별 값 */
function axisTooltip(params: unknown, unitOf: (seriesName: string) => string): string {
  const items = Array.isArray(params) ? (params as { axisValue?: string; seriesName?: string; value?: unknown; marker?: string }[]) : [];
  const rows = items.flatMap((item) => (typeof item.value === 'number' ? [`${item.marker ?? ''}${item.seriesName ?? ''}: ${formatNumber(item.value, 3)} ${unitOf(item.seriesName ?? '')}`] : []));
  return [items[0]?.axisValue ?? '', ...rows].join('<br/>');
}

function ledgerOption(theme: ChartTheme, days: Days, withTerms: boolean): EChartOption {
  const bar = (name: string, color: string, pick: (d: Days[number]) => number | null) => ({ type: 'bar' as const, name, stack: 'use', color, barMaxWidth: 14, data: days.map(pick) });
  const terms = withTerms
    ? [bar('연료전지 소비', theme.tones.hydrogen[0], (d) => d.fcConsumed), bar('저장 증감', theme.tones.hydrogen[1], (d) => d.storedDelta), bar('배기 추정', theme.tones.neutral[0], (d) => d.ventedEst)]
    : [];
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 24, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), formatter: (params: unknown) => axisTooltip(params, () => 'kg') },
    xAxis: { type: 'category', data: days.map((d) => d.date), ...axisStyle(theme) },
    yAxis: { type: 'value', name: 'kg / 일', ...axisStyle(theme), splitLine: splitLine(theme) },
    series: [
      ...terms,
      bar('잔차', theme.series[1] ?? theme.warn, (d) => d.residual),
      { type: 'line', name: '생산', data: days.map((d) => d.produced), color: theme.ink, symbol: 'circle', symbolSize: 4, lineStyle: { width: 1.5 } },
    ],
  };
}

/** 일 수소 원장: 생산(선) = 연료전지 소비 + 저장 증감 + 배기 추정 + 잔차 (쌓은 막대, 음수는 아래로) */
export function LedgerBarChart({ days, withTerms }: Readonly<{ days: Days; withTerms: boolean }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? ledgerOption(theme, days, withTerms) : null), [theme, days, withTerms]);
  return <EChart option={option} className="h-80 w-full" ariaLabel="일 수소 원장 막대: 생산·연료전지 소비·저장 증감·배기 추정·잔차 (kg)" />;
}

function cusumOption(theme: ChartTheme, evidence: MassBalanceEvidence): EChartOption {
  const dates = [...new Set([...evidence.days.map((d) => d.date), ...evidence.cusum.points.map((p) => p.date)])].sort();
  const pct = new Map(evidence.days.map((d) => [d.date, d.residualPct]));
  const path = new Map(evidence.cusum.points.map((p) => [p.date, p.s]));
  const events = [
    evidence.cusum.changeStartDay === null ? null : { xAxis: evidence.cusum.changeStartDay, label: { formatter: '변화 시작', color: theme.warn, position: 'insideStartTop' as const }, lineStyle: { color: theme.warn, type: 'dashed' as const } },
    evidence.cusum.alarmDay === null ? null : { xAxis: evidence.cusum.alarmDay, label: { formatter: 'CUSUM 경보', color: theme.crit, position: 'insideEndTop' as const }, lineStyle: { color: theme.crit, type: 'dashed' as const } },
  ].filter((line): line is NonNullable<typeof line> => line !== null);
  const hasPath = evidence.cusum.points.length > 0;
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 64, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), formatter: (params: unknown) => axisTooltip(params, (name) => (name === '잔차율' ? '%' : 'σ')) },
    xAxis: { type: 'category', data: dates, ...axisStyle(theme) },
    yAxis: [
      { type: 'value', name: '잔차율 [%]', ...axisStyle(theme), splitLine: splitLine(theme) },
      { type: 'value', name: 'CUSUM [σ]', min: 0, position: 'right', ...axisStyle(theme), splitLine: { show: false } },
    ],
    series: [
      { type: 'bar', name: '잔차율', yAxisIndex: 0, barMaxWidth: 12, color: theme.tones.hydrogen[1], data: dates.map((d) => pct.get(d) ?? null), markLine: { silent: true, symbol: 'none', data: events } },
      ...(hasPath
        ? [
            {
              type: 'line' as const,
              name: `CUSUM (${evidence.cusum.direction === 'down' ? '하향' : '상향'})`,
              yAxisIndex: 1,
              color: theme.accent,
              connectNulls: true,
              showSymbol: false,
              lineStyle: { width: 2 },
              data: dates.map((d) => path.get(d) ?? null),
              markLine: evidence.cusum.h === null ? undefined : { silent: true, symbol: 'none', lineStyle: { color: theme.crit, type: 'dotted' as const }, label: { color: theme.crit, position: 'insideEndTop' as const, formatter: `경보 경계 h ${formatNumber(evidence.cusum.h, 1)}` }, data: [{ yAxis: evidence.cusum.h }] },
            },
          ]
        : []),
    ],
  };
}

/** 일 잔차율 막대 + 기준 구간으로 표준화한 CUSUM 누적합(오른쪽 축)·경보 경계 h·변화 시작·경보일 */
export function ResidualCusumChart({ evidence }: Readonly<{ evidence: MassBalanceEvidence }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? cusumOption(theme, evidence) : null), [theme, evidence]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="수소 물질수지 일 잔차율과 CUSUM 누적합·경보 경계" />;
}
