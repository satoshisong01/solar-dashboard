'use client';

import { BarChart, LineChart, ScatterChart, type BarSeriesOption, type LineSeriesOption, type ScatterSeriesOption } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  type DataZoomComponentOption,
  type GridComponentOption,
  type LegendComponentOption,
  type MarkAreaComponentOption,
  type MarkLineComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import { init, use as registerChartParts, type ComposeOption, type ECharts } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

// 쓰는 구성요소만 등록한다 (트리셰이킹).
registerChartParts([LineChart, BarChart, ScatterChart, GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent, MarkLineComponent, LegendComponent, CanvasRenderer]);

export type EChartOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
  | MarkAreaComponentOption
  | MarkLineComponentOption
  | LegendComponentOption
>;

const DEFAULT_REPLACE_MERGE: readonly string[] = ['series', 'yAxis', 'legend'];

/** dataZoom의 현재 범위 (축 전체 대비 %) */
export interface ZoomRange {
  readonly startPct: number;
  readonly endPct: number;
}

type EChartProps = Readonly<{
  option: EChartOption | null;
  /** setOption에서 통째로 바꿀 구성요소. 나머지(dataZoom 범위 등)는 병합해 유지한다 */
  replaceMerge?: readonly string[];
  onDataZoom?: (range: ZoomRange) => void;
  className?: string;
  ariaLabel: string;
}>;

function readZoom(chart: ECharts): ZoomRange | null {
  const option = chart.getOption() as { dataZoom?: readonly { start?: number; end?: number }[] };
  const zoom = option.dataZoom?.[0];
  if (!zoom || zoom.start === undefined || zoom.end === undefined) return null;
  return { startPct: zoom.start, endPct: zoom.end };
}

/** ECharts 인스턴스를 DOM 수명에 묶는다: 마운트 때 init, 크기 변화에 resize, 언마운트 때 dispose */
export function EChart({ option, replaceMerge = DEFAULT_REPLACE_MERGE, onDataZoom, className = '', ariaLabel }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const zoomHandlerRef = useRef(onDataZoom);

  useEffect(() => {
    zoomHandlerRef.current = onDataZoom;
  }, [onDataZoom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.on('datazoom', () => {
      const zoom = readZoom(chart);
      if (zoom) zoomHandlerRef.current?.(zoom);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (option) chartRef.current?.setOption(option, { replaceMerge: [...replaceMerge] });
  }, [option, replaceMerge]);

  return <div ref={containerRef} role="img" aria-label={ariaLabel} className={className} />;
}
