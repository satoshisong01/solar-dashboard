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
