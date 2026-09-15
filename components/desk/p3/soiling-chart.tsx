'use client';

import { useMemo } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import type { SoilingEvidence } from '@/lib/desk/p3-evidence-types';
import { kstNoonMs, resetKindLabel } from '@/lib/desk/p3-view';
import { formatKstDate, formatNumber } from '@/lib/format';
import { axisStyle, baseOption, pointOf, splitLine, tooltipBase } from './chart-style';

type DatePi = readonly { readonly date: string; readonly pi: number }[];

const xy = (points: DatePi): [number, number][] => points.flatMap((p) => {
  const x = kstNoonMs(p.date);
  return x === null ? [] : [[x, p.pi]];
});

function soilingOption(theme: ChartTheme, evidence: SoilingEvidence): EChartOption {
  const segmentLines = evidence.segments.flatMap((segment, i) => {
    const current = i === evidence.segments.length - 1;
    return segment.line === null ? [] : [{ type: 'line' as const, name: current ? '현재 구간 기울기' : '이전 구간 기울기', data: xy(segment.line), color: current ? theme.accent : theme.ink2, showSymbol: false, lineStyle: { width: current ? 2.5 : 1.5, type: current ? ('solid' as const) : ('dashed' as const) } }];
  });
  // 예전 스냅샷은 구간 선이 없어 현재 구간 선만 그린다
  const lines = segmentLines.length > 0 ? segmentLines : evidence.currentLine === null ? [] : [{ type: 'line' as const, name: '현재 구간 기울기', data: xy(evidence.currentLine), color: theme.accent, showSymbol: false, lineStyle: { width: 2.5 } }];
  const resetLines = evidence.resets.flatMap((reset) => {
    const x = kstNoonMs(reset.date);
    const color = reset.kind === 'cleaning' ? theme.tones.hydrogen[0] : theme.warn;
    return x === null ? [] : [{ xAxis: x, lineStyle: { color, type: 'dashed' as const }, label: { color, formatter: `${resetKindLabel(reset.kind)}${reset.recoveryPct === null ? '' : ` +${formatNumber(reset.recoveryPct, 1)}%`}`, position: 'insideEndTop' as const } }];
  });
  return {
    ...baseOption(theme),
    grid: { left: 64, right: 24, top: 56, bottom: 40 },
    tooltip: {
      trigger: 'item',
      ...tooltipBase(theme),
      formatter: (params: unknown) => {
        const point = pointOf(params);
        return point ? `${formatKstDate(point[0])}: 성능지수 ${formatNumber(point[1], 4)}` : '';
      },
    },
    xAxis: { type: 'time', ...axisStyle(theme), axisLabel: { color: theme.muted, hideOverlap: true, formatter: (v: number) => formatKstDate(v).slice(5) } },
    yAxis: { type: 'value', name: '온도 보정 성능지수 (PI)', scale: true, ...axisStyle(theme), splitLine: splitLine(theme) },
    series: [{ type: 'scatter', name: '맑은 날 PI', data: xy(evidence.piPoints), color: theme.muted, symbolSize: 7, markLine: { silent: true, symbol: 'none', data: resetLines } }, ...lines],
  };
}

/** 맑은 날 성능지수 산점도 + 복원(세척·강우) 이벤트 세로선 + 구간별 Theil–Sen 기울기선 */
export function SoilingChart({ evidence }: Readonly<{ evidence: SoilingEvidence }>) {
  const theme = useChartTheme();
  const option = useMemo(() => (theme ? soilingOption(theme, evidence) : null), [theme, evidence]);
  return <EChart option={option} className="h-80 w-full" ariaLabel="맑은 날 온도 보정 성능지수 산점도, 복원 이벤트 세로선, 구간별 기울기선" />;
}
