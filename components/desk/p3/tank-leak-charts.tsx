'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { TankCurvePoint, TankHoldView } from '@/lib/desk/p3-evidence-types';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';
import { axisStyle, baseOption, pointOf, splitLine, tooltipBase } from './chart-style';

const pairs = (points: readonly TankCurvePoint[], pick: (p: TankCurvePoint) => number | null) => points.flatMap((p) => (pick(p) === null ? [] : [[p.ts, pick(p) as number]]));

function curveOption(theme: ChartTheme, points: readonly TankCurvePoint[]): EChartOption {
  const massColor = theme.tones.hydrogen[0];
  const pressureColor = theme.ink2;
  const tempColor = theme.series[1] ?? theme.warn;
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 120, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), valueFormatter: (value) => (typeof value === 'number' ? formatNumber(value, 3) : String(value)) },
    xAxis: { type: 'time', ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDateTime(v).slice(11) } },
    yAxis: [
      { type: 'value', name: '보정 질량 [kg]', scale: true, ...axisStyle(theme), splitLine: splitLine(theme) },
      { type: 'value', name: '압력 [bar]', scale: true, position: 'right', ...axisStyle(theme), splitLine: { show: false } },
      { type: 'value', name: '온도 [°C]', scale: true, position: 'right', offset: 60, ...axisStyle(theme), splitLine: { show: false } },
    ],
    series: [
      { type: 'line', name: '온도 보정 질량', yAxisIndex: 0, data: pairs(points, (p) => p.massKg), color: massColor, showSymbol: false, lineStyle: { width: 2.5 } },
      { type: 'line', name: '압력', yAxisIndex: 1, data: pairs(points, (p) => p.pBar), color: pressureColor, showSymbol: false, lineStyle: { width: 1.5, type: 'dashed' } },
      { type: 'line', name: '온도', yAxisIndex: 2, data: pairs(points, (p) => p.tC), color: tempColor, showSymbol: false, lineStyle: { width: 1.5 } },
    ],
  };
}

/** 대표 정지 보유 구간: 압력·온도와 상태식으로 보정한 질량 (보정 질량이 줄면 누설, 압력만 줄고 질량이 그대로면 온도 영향) */
export function HoldCurveChart({ points }: Readonly<{ points: readonly TankCurvePoint[] }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? curveOption(theme, points) : null), [theme, points]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="대표 정지 보유 구간 압력·온도·온도 보정 질량 곡선" />;
}

interface LeakLines {
  readonly leakKgPerDay: number | null;
  readonly thresholdKgPerDay: number | null;
  readonly safetyKgPerDay: number | null;
}

function leakOption(theme: ChartTheme, holds: readonly TankHoldView[], lines: LeakLines): EChartOption {
  const byRole = (role: TankHoldView['role']) => holds.filter((h) => h.role === role && h.lossKgPerDay !== null);
  const holdOf = (x: number) => holds.find((h) => h.start === x);
  const markLines = [
    lines.leakKgPerDay === null ? null : { yAxis: lines.leakKgPerDay, name: '결합 누설률', lineStyle: { color: theme.accent, type: 'solid' as const, width: 2 }, label: { color: theme.accent, formatter: `결합 누설률 ${formatNumber(lines.leakKgPerDay, 3)}` } },
    lines.thresholdKgPerDay === null ? null : { yAxis: lines.thresholdKgPerDay, name: '유의 기준', lineStyle: { color: theme.warn, type: 'dashed' as const }, label: { color: theme.warn, formatter: `유의 기준 ${formatNumber(lines.thresholdKgPerDay, 3)}` } },
    lines.safetyKgPerDay === null ? null : { yAxis: lines.safetyKgPerDay, name: '안전 기준', lineStyle: { color: theme.crit, type: 'dashed' as const }, label: { color: theme.crit, formatter: `안전 기준 ${formatNumber(lines.safetyKgPerDay, 2)}` } },
  ].filter((line): line is NonNullable<typeof line> => line !== null);
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 120, top: 48, bottom: 40 },
    tooltip: {
      trigger: 'item',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const point = pointOf(params);
        const hold = point ? holdOf(point[0]) : undefined;
        if (!hold) return '';
        return [`${formatKstDateTime(hold.start)} 시작 · ${formatNumber(hold.hours, 1)} h`, `손실률 ${formatNumber(hold.lossKgPerDay, 4)} kg/일 (95% CI ${formatNumber(hold.ciLow, 3)} ~ ${formatNumber(hold.ciHigh, 3)})`, `평균 ${formatNumber(hold.pMeanBar, 1)} bar · ${formatNumber(hold.tMeanC, 1)} °C (변화 ${formatNumber(hold.tRateCPerDay, 2)} °C/일)`].join('<br/>');
      },
    },
    xAxis: { type: 'time', ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDate(v).slice(5) } },
    yAxis: { type: 'value', name: '구간 손실률 [kg/일]', scale: true, ...axisStyle(theme), splitLine: splitLine(theme) },
    series: [
      { type: 'scatter', name: '기준 구간', data: byRole('reference').map((h) => [h.start, h.lossKgPerDay as number]), color: theme.muted, symbolSize: 7 },
      { type: 'scatter', name: '최근 구간', data: byRole('recent').map((h) => [h.start, h.lossKgPerDay as number]), color: theme.accent, symbol: 'diamond', symbolSize: 10, markLine: { silent: true, symbol: 'none', label: { position: 'end' }, data: markLines } },
    ],
  };
}

/** 정지 보유 구간별 손실률 추세: 기준(회색)·최근(마름모) + 결합 누설률·유의 기준·안전 기준 선 */
export function LeakRateChart({ holds, lines }: Readonly<{ holds: readonly TankHoldView[]; lines: LeakLines }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? leakOption(theme, holds, lines) : null), [theme, holds, lines]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="정지 보유 구간별 손실률 추세와 결합 누설률·유의 기준·안전 기준" />;
}
