// 인쇄용 정적 SVG 차트 기하 (순수): 근거 요약 시계열(≤120점) → 점·추세선 좌표와 축 눈금. 서버 컴포넌트가 <svg>로 그린다.
// ECharts SSR 대신 정적 SVG를 쓴다: 문자열 HTML 주입 없이 React로 그리고, 인쇄 화면에 클라이언트 JS가 필요 없다.
import { formatKstDate, formatNumber } from '@/lib/format';
import type { PackSeries } from './pack-types';

export interface ChartBox {
  readonly width: number;
  readonly height: number;
}

export interface Tick {
  readonly at: number;
  readonly label: string;
}

export interface SeriesChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly plot: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly dots: readonly (readonly [number, number])[];
  /** 추세선 두 끝점 (없으면 null) */
  readonly line: readonly [readonly [number, number], readonly [number, number]] | null;
  readonly xTicks: readonly Tick[];
  readonly yTicks: readonly Tick[];
}

const MARGIN = { left: 52, right: 12, top: 10, bottom: 26 };
const TICKS = 4;

function niceStep(span: number, count: number): number {
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

function extent(values: readonly number[]): readonly [number, number] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low === high) return [low - 1, high + 1];
  const pad = (high - low) * 0.05;
  return [low - pad, high + pad];
}

const decimalsFor = (step: number): number => Math.min(3, Math.max(0, -Math.floor(Math.log10(step))));

/** 점이 2개 미만이면 null */
export function buildSeriesChart(series: PackSeries, box: ChartBox): SeriesChartGeometry | null {
  if (series.points.length < 2) return null;
  const all = [...series.points, ...(series.line ?? [])];
  const [x0, x1] = extent(all.map(([x]) => x));
  const [y0, y1] = extent(all.map(([, y]) => y));
  const plot = { left: MARGIN.left, top: MARGIN.top, right: box.width - MARGIN.right, bottom: box.height - MARGIN.bottom };
  const sx = (x: number) => Math.round((plot.left + ((x - x0) / (x1 - x0)) * (plot.right - plot.left)) * 10) / 10;
  const sy = (y: number) => Math.round((plot.bottom - ((y - y0) / (y1 - y0)) * (plot.bottom - plot.top)) * 10) / 10;
  const yStep = niceStep(y1 - y0, TICKS);
  const yTicks = Array.from({ length: Math.floor(y1 / yStep) - Math.ceil(y0 / yStep) + 1 }, (_, i) => (Math.ceil(y0 / yStep) + i) * yStep).map((y) => ({ at: sy(y), label: formatNumber(y, decimalsFor(yStep)) }));
  const xTicks = Array.from({ length: TICKS + 1 }, (_, i) => x0 + ((x1 - x0) * i) / TICKS).map((x) => ({ at: sx(x), label: series.xKind === 'time' ? formatKstDate(x).slice(5) : series.xKind === 'elapsed_days' ? `${formatNumber(x, 0)}일` : `${formatNumber(x, 0)} h` }));
  const [a, b] = series.line ?? [];
  return {
    width: box.width,
    height: box.height,
    plot,
    dots: series.points.map(([x, y]) => [sx(x), sy(y)] as const),
    line: a && b ? [[sx(a[0]), sy(a[1])], [sx(b[0]), sy(b[1])]] : null,
    xTicks,
    yTicks,
  };
}

export interface BarItem {
  readonly label: string;
  readonly value: number;
}

export interface BarGeometry {
  readonly label: string;
  readonly value: number;
  /** 막대 왼쪽 x·폭, 위쪽 y·높이 (음수 값은 기준선 아래로) */
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
  readonly negative: boolean;
}

export interface BarChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly plot: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  /** 0 기준선 y */
  readonly baseline: number;
  readonly bars: readonly BarGeometry[];
  readonly yTicks: readonly Tick[];
}

const BAR_MARGIN = { left: 52, right: 12, top: 14, bottom: 34 };

/** 막대 차트 기하 (원장 기간 합 표시용). 0을 늘 포함하고 음수 막대는 기준선 아래로. 항목이 없거나 모두 0이면 null */
export function buildBarChart(items: readonly BarItem[], box: ChartBox): BarChartGeometry | null {
  const values = items.map((item) => item.value).filter((v) => Number.isFinite(v));
  if (items.length === 0 || values.length !== items.length || values.every((v) => v === 0)) return null;
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const step = niceStep(high - low, TICKS);
  const y0 = Math.floor(low / step) * step;
  const y1 = Math.ceil(high / step) * step;
  const plot = { left: BAR_MARGIN.left, top: BAR_MARGIN.top, right: box.width - BAR_MARGIN.right, bottom: box.height - BAR_MARGIN.bottom };
  const sy = (y: number) => Math.round((plot.bottom - ((y - y0) / (y1 - y0)) * (plot.bottom - plot.top)) * 10) / 10;
  const slot = (plot.right - plot.left) / items.length;
  const width = Math.round(slot * 0.6 * 10) / 10;
  const baseline = sy(0);
  const bars = items.map((item, i) => {
    const top = sy(Math.max(0, item.value));
    const bottom = sy(Math.min(0, item.value));
    return { label: item.label, value: item.value, x: Math.round((plot.left + slot * i + (slot - width) / 2) * 10) / 10, width, y: top, height: Math.round((bottom - top) * 10) / 10, negative: item.value < 0 };
  });
  const count = Math.round((y1 - y0) / step);
  const yTicks = Array.from({ length: count + 1 }, (_, i) => y0 + i * step).map((y) => ({ at: sy(y), label: formatNumber(y, decimalsFor(step)) }));
  return { width: box.width, height: box.height, plot, baseline, bars, yTicks };
}
