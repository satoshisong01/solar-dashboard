// P3 근거 차트 공용 스타일 조각 (클라이언트 차트에서 쓴다). 색은 app/globals.css 토큰(useChartTheme)만 쓴다.
import type { ChartTheme } from '@/components/charts/chart-theme';

export const axisStyle = (theme: ChartTheme) => ({ nameTextStyle: { color: theme.muted }, axisLabel: { color: theme.muted, hideOverlap: true }, axisLine: { lineStyle: { color: theme.rule } } });

export const splitLine = (theme: ChartTheme) => ({ lineStyle: { color: theme.rule } });

export const tooltipBase = (theme: ChartTheme) => ({ confine: true, backgroundColor: theme.surface, borderColor: theme.rule, textStyle: { color: theme.ink, fontSize: 12 } });

export const baseOption = (theme: ChartTheme) => ({ animation: false, textStyle: { color: theme.ink2, fontFamily: 'inherit' }, legend: { top: 0, left: 0, textStyle: { color: theme.ink2 } } });

/** 툴팁 파라미터에서 [x, y] 값 */
export function pointOf(params: unknown): readonly [number, number] | null {
  const value = (params as { value?: unknown }).value;
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number' ? [value[0], value[1]] : null;
}
