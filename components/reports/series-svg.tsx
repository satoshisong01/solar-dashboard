import type { PackSeries } from '@/lib/report/pack-types';
import { buildSeriesChart } from '@/lib/report/svg-chart';

const BOX = { width: 640, height: 180 };

/** 근거 요약 시계열 정적 SVG (서버 렌더, 인쇄용). 점 ≤ 120 + 추세선 */
export function SeriesSvg({ series, label }: Readonly<{ series: PackSeries; label: string }>) {
  const chart = buildSeriesChart(series, BOX);
  if (!chart) return null;
  const { plot } = chart;
  return (
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={label} className="h-auto w-full" style={{ fontFamily: 'inherit' }}>
      <rect x={plot.left} y={plot.top} width={plot.right - plot.left} height={plot.bottom - plot.top} fill="none" stroke="var(--rule)" />
      {chart.yTicks.map((tick) => (
        <g key={`y-${tick.at}`}>
          <line x1={plot.left} x2={plot.right} y1={tick.at} y2={tick.at} stroke="var(--rule)" strokeDasharray="2 3" />
          <text x={plot.left - 6} y={tick.at + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
            {tick.label}
          </text>
        </g>
      ))}
      {chart.xTicks.map((tick, i) => (
        <text key={`x-${i}`} x={tick.at} y={plot.bottom + 16} textAnchor={i === 0 ? 'start' : i === chart.xTicks.length - 1 ? 'end' : 'middle'} fontSize={10} fill="var(--muted)">
          {tick.label}
        </text>
      ))}
      {chart.dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2} fill="var(--accent)" opacity={0.75} />
      ))}
      {chart.line && <line x1={chart.line[0][0]} y1={chart.line[0][1]} x2={chart.line[1][0]} y2={chart.line[1][1]} stroke="var(--crit)" strokeWidth={1.5} />}
    </svg>
  );
}
