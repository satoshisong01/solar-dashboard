'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import { kstNoonMs } from '@/lib/desk/p3-view';
import type { HxPointView, O2DayView, PrvHoldView } from '@/lib/desk/p3-evidence-types';
import { formatKstDate, formatNumber } from '@/lib/format';
import { axisStyle, baseOption, pointOf, splitLine, tooltipBase } from './chart-style';

type MarkLine = Readonly<{ yAxis: number; lineStyle: { color: string; type: 'dashed' | 'solid'; width?: number }; label: { color: string; formatter: string } }>;

const line = (yAxis: number | null, color: string, formatter: string, type: 'dashed' | 'solid' = 'dashed', width?: number): MarkLine[] =>
  yAxis === null ? [] : [{ yAxis, lineStyle: { color, type, ...(width === undefined ? {} : { width }) }, label: { color, formatter } }];

/** 'YYYY-MM-DD' 줄 목록 → [정오 epoch ms, 값] (날짜를 읽을 수 없거나 값이 없는 줄은 뺀다) */
function dated<T extends { readonly date: string }>(rows: readonly T[], pick: (row: T) => number | null): [number, number][] {
  return rows.flatMap((row) => {
    const x = kstNoonMs(row.date);
    const y = pick(row);
    return x === null || y === null ? [] : [[x, y] as [number, number]];
  });
}

const dateAxis = (theme: ChartTheme) => ({ type: 'time' as const, ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDate(v).slice(5) } });

interface PrvLines {
  readonly recentMbarPerH: number | null;
  readonly referenceMbarPerH: number | null;
  readonly warnMbarPerH: number | null;
  readonly alertMbarPerH: number | null;
}

function prvOption(theme: ChartTheme, holds: readonly PrvHoldView[], lines: PrvLines): EChartOption {
  const holdAt = (x: number) => holds.find((hold) => kstNoonMs(hold.date) === x);
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 132, top: 48, bottom: 40 },
    tooltip: {
      trigger: 'item',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const point = pointOf(params);
        const hold = point ? holdAt(point[0]) : undefined;
        if (!hold) return '';
        return [
          `${hold.date} · ${formatNumber(hold.hours, 0)} h`,
          `크리프율 ${formatNumber(hold.creepMbarPerH, 1)} mbar/h`,
          `하류 압력 ${formatNumber(hold.startBar, 3)} → ${formatNumber(hold.endBar, 3)} bar`,
          `안정화 뒤 남은 비율 ${formatNumber(hold.settleRatio, 2)}`,
        ].join('<br/>');
      },
    },
    xAxis: dateAxis(theme),
    yAxis: { type: 'value', name: '크리프율 [mbar/h]', scale: true, ...axisStyle(theme), splitLine: splitLine(theme) },
    series: [
      {
        type: 'scatter',
        name: '무유동 구간',
        data: dated(holds, (hold) => hold.creepMbarPerH),
        color: theme.accent,
        symbolSize: 9,
        markLine: {
          silent: true,
          symbol: 'none',
          label: { position: 'end' },
          data: [
            ...line(lines.recentMbarPerH, theme.accent, `최근 중앙값 ${formatNumber(lines.recentMbarPerH, 1)}`, 'solid', 2),
            ...line(lines.referenceMbarPerH, theme.muted, `기준 중앙값 ${formatNumber(lines.referenceMbarPerH, 1)}`),
            ...line(lines.warnMbarPerH, theme.warn, `경고 기준 ${formatNumber(lines.warnMbarPerH, 0)}`),
            ...line(lines.alertMbarPerH, theme.crit, `주의 기준 ${formatNumber(lines.alertMbarPerH, 0)}`),
          ],
        },
      },
    ],
  };
}

/** prv.seat_leak: 무유동 구간별 하류 압력 상승률과 경고·주의 기준선 */
export function PrvCreepChart({ holds, lines }: Readonly<{ holds: readonly PrvHoldView[]; lines: PrvLines }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? prvOption(theme, holds, lines) : null), [theme, holds, lines]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="무유동 구간별 하류 압력 상승률과 경고·주의 기준선" />;
}

interface HxLines {
  readonly referenceK: number | null;
  readonly recentK: number | null;
  readonly designApproachK: number | null;
}

function hxOption(theme: ChartTheme, points: readonly HxPointView[], lines: HxLines): EChartOption {
  const hasUa = points.some((point) => point.uaKwK !== null);
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 148, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), valueFormatter: (value) => (typeof value === 'number' ? formatNumber(value, 3) : String(value)) },
    xAxis: dateAxis(theme),
    yAxis: [
      { type: 'value', name: '접근온도 [K]', scale: true, ...axisStyle(theme), splitLine: splitLine(theme) },
      { type: 'value', name: 'UA [kW/K]', scale: true, position: 'right', ...axisStyle(theme), splitLine: { show: false } },
    ],
    series: [
      {
        type: 'scatter',
        name: '접근온도',
        yAxisIndex: 0,
        data: dated(points, (point) => point.approachK),
        color: theme.accent,
        symbolSize: 7,
        markLine: {
          silent: true,
          symbol: 'none',
          label: { position: 'end' },
          data: [
            ...line(lines.recentK, theme.accent, `최근 대표 ${formatNumber(lines.recentK, 1)} K`, 'solid', 2),
            ...line(lines.referenceK, theme.muted, `기준 ${formatNumber(lines.referenceK, 1)} K`),
            ...line(lines.designApproachK, theme.warn, `설계 ${formatNumber(lines.designApproachK, 1)} K`),
          ],
        },
      },
      ...(hasUa ? [{ type: 'scatter' as const, name: 'UA', yAxisIndex: 1, data: dated(points, (point) => point.uaKwK), color: theme.tones.hydrogen[0], symbol: 'diamond' as const, symbolSize: 7 }] : []),
    ],
  };
}

/** hx.fouling: 최근 정상상태 시간별 접근온도·UA와 기준·설계 접근온도 선 */
export function HxApproachChart({ points, lines }: Readonly<{ points: readonly HxPointView[]; lines: HxLines }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? hxOption(theme, points, lines) : null), [theme, points, lines]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="접근온도와 UA 추세, 기준·설계 접근온도 선" />;
}

interface O2Lines {
  readonly limitPct: number | null;
  readonly lelPct: number | null;
  readonly referencePct: number | null;
  readonly recentPct: number | null;
  readonly recentP95Pct: number | null;
}

/** 법정 한계선은 늘 보이게 축 위쪽을 한계선보다 조금 넓게 잡는다 (한계선이 그림 밖에 있으면 여유를 읽을 수 없다) */
function o2Max(days: readonly O2DayView[], lines: O2Lines): number | undefined {
  const values = [...days.map((day) => day.maxPct), lines.limitPct, lines.recentP95Pct].filter((value): value is number => value !== null);
  return values.length === 0 ? undefined : Math.ceil(Math.max(...values) * 1.1 * 10) / 10;
}

function o2Option(theme: ChartTheme, days: readonly O2DayView[], lines: O2Lines): EChartOption {
  const max = o2Max(days, lines);
  const inRange = (value: number | null) => (value !== null && max !== undefined && value > max ? null : value);
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 148, top: 56, bottom: 40 },
    tooltip: { trigger: 'axis', ...tooltipBase(theme), valueFormatter: (value) => (typeof value === 'number' ? `${formatNumber(value, 2)} vol%` : String(value)) },
    xAxis: dateAxis(theme),
    yAxis: { type: 'value', name: '산소 중 수소 [vol%]', min: 0, max, ...axisStyle(theme), splitLine: splitLine(theme) },
    series: [
      { type: 'line', name: '일 최대', data: dated(days, (day) => day.maxPct), color: theme.ink2, showSymbol: false, lineStyle: { width: 1, type: 'dashed' } },
      {
        type: 'line',
        name: '일 중앙값',
        data: dated(days, (day) => day.medianPct),
        color: theme.accent,
        showSymbol: false,
        lineStyle: { width: 2.5 },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { position: 'end' },
          data: [
            ...line(lines.limitPct, theme.crit, `압축금지 한계 ${formatNumber(lines.limitPct, 1)} vol%`, 'solid', 2),
            ...line(inRange(lines.lelPct), theme.crit, `폭발하한 ${formatNumber(lines.lelPct, 1)} vol%`),
            ...line(lines.recentP95Pct, theme.warn, `최근 95퍼센타일 ${formatNumber(lines.recentP95Pct, 2)}`),
            ...line(lines.recentPct, theme.accent, `최근 중앙값 ${formatNumber(lines.recentPct, 2)}`),
            ...line(lines.referencePct, theme.muted, `기준 중앙값 ${formatNumber(lines.referencePct, 2)}`),
          ],
        },
      },
    ],
  };
}

/** o2.purity_drift: 일 HTO 중앙값·최대와 법정 한계선(압축금지·폭발하한) */
export function O2PurityChart({ days, lines }: Readonly<{ days: readonly O2DayView[]; lines: O2Lines }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? o2Option(theme, days, lines) : null), [theme, days, lines]);
  return <EChart option={option} className="h-72 w-full" ariaLabel="일 산소 중 수소 농도 추세와 압축금지 한계선" />;
}
