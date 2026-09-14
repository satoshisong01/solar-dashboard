'use client';

import { useMemo, useState } from 'react';
import { useChartTheme, type ChartTheme } from '@/components/charts/chart-theme';
import { EChart, type EChartOption } from '@/components/charts/echart';
import { OVERLAY_AXES, OVERLAY_AXIS_META, overlayXY, summarizeCurve, type ChargeCurve, type OverlayAxis } from '@/lib/desk/overlay';
import { formatKstDate, formatKstDateTime, formatNumber } from '@/lib/format';

const TOGGLE_CLASS =
  'rounded-md px-3 py-1.5 text-sm font-medium text-ink-2 hover:text-ink aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-sm';

type Curves = Readonly<{ reference: ChargeCurve | null; recent: ChargeCurve | null }>;

const curveName = (label: string, curve: ChargeCurve) => `${label} ${formatKstDate(curve.start)}${curve.capacityAh === null ? '' : ` (${formatNumber(curve.capacityAh, 0)} Ah)`}`;

function buildOverlayOption(theme: ChartTheme, curves: Curves, axis: OverlayAxis): EChartOption {
  const meta = OVERLAY_AXIS_META[axis];
  const lines = [
    curves.reference && { name: curveName('기준', curves.reference), curve: curves.reference, color: theme.muted, type: 'dashed' as const },
    curves.recent && { name: curveName('최근', curves.recent), curve: curves.recent, color: theme.accent, type: 'solid' as const },
  ].filter((line): line is NonNullable<typeof line> => Boolean(line));
  const axisStyle = { nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.rule } }, splitLine: { lineStyle: { color: theme.rule } } };
  return {
    animation: false,
    textStyle: { color: theme.ink2, fontFamily: 'inherit' },
    grid: { left: 56, right: 24, top: 48, bottom: 48 },
    legend: { top: 0, left: 0, textStyle: { color: theme.ink2 } },
    tooltip: { trigger: 'axis', backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 }, valueFormatter: (value) => (typeof value === 'number' ? formatNumber(value, 2) : String(value)) },
    xAxis: { type: 'value', name: meta.xName, nameLocation: 'middle', nameGap: 28, scale: axis === 'soc', ...axisStyle, splitLine: { show: false } },
    yAxis: { type: 'value', name: meta.yName, scale: axis !== 'soc', ...axisStyle },
    series: lines.map((line) => ({ type: 'line' as const, name: line.name, data: overlayXY(line.curve.points, axis).map(([x, y]) => [x, y]), showSymbol: false, color: line.color, lineStyle: { width: 2, type: line.type } })),
  };
}

function CurveSummaries({ curves }: Readonly<{ curves: Curves }>) {
  const rows = [
    ['기준 대표 충전', curves.reference],
    ['최근 대표 충전', curves.recent],
  ] as const;
  return (
    <ul className="grid gap-2 text-xs text-ink-2 sm:grid-cols-2">
      {rows.map(([label, curve]) => {
        const summary = curve ? summarizeCurve(curve.points) : null;
        return (
          <li key={label} className="rounded-md border border-rule px-3 py-2">
            <span className="font-medium text-ink">{label}</span>
            {curve && summary ? (
              <span className="block">
                시작 {formatKstDateTime(curve.start)} · {formatNumber(summary.durationH, 2)} h · 누적 {formatNumber(summary.ahTotal, 1)} Ah · SOC {formatNumber(summary.socStart, 1)} → {formatNumber(summary.socEnd, 1)}%
              </span>
            ) : (
              <span className="block text-muted">곡선 없음</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type OverlayChartProps = Readonly<{ curves: Curves; chargeTimeText: string | null }>;

/** 기준·최근 대표 충전 곡선을 t=0 정렬로 겹친다. x축: 경과시간 / 누적 Ah / SOC */
export function OverlayChart({ curves, chargeTimeText }: OverlayChartProps) {
  const theme = useChartTheme();
  const [axis, setAxis] = useState<OverlayAxis>('elapsed');
  const option = useMemo(() => (theme ? buildOverlayOption(theme, curves, axis) : null), [theme, curves, axis]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="오버레이 x축" className="inline-flex gap-1 rounded-lg border border-rule bg-sunken p-1">
          {OVERLAY_AXES.map((key) => (
            <button key={key} type="button" aria-pressed={axis === key} onClick={() => setAxis(key)} className={TOGGLE_CLASS}>
              {OVERLAY_AXIS_META[key].label}
            </button>
          ))}
        </div>
        {chargeTimeText && (
          <p className="text-sm text-ink">
            <span className="text-xs text-ink-2">기준 전류 환산 충전시간 </span>
            <span className="font-mono tabular-nums">{chargeTimeText}</span>
          </p>
        )}
      </div>
      <EChart option={option} className="h-72 w-full md:h-80" ariaLabel={`에피소드 오버레이 차트: x축 ${OVERLAY_AXIS_META[axis].xName}, y축 ${OVERLAY_AXIS_META[axis].yName}`} />
      <CurveSummaries curves={curves} />
    </div>
  );
}
