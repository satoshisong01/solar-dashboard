import { describe, expect, it } from 'vitest';
import { buildBarChart, buildSeriesChart } from './svg-chart';

describe('buildSeriesChart', () => {
  it('점을 그림 영역 안으로 옮기고 추세선·눈금을 만든다', () => {
    const chart = buildSeriesChart({ xKind: 'op_hours', yName: 'mV', points: [[1000, -8], [1500, 1], [2000, 12]], line: [[1000, -9], [2000, 10]] }, { width: 400, height: 160 });
    expect(chart).not.toBeNull();
    if (!chart) return;
    for (const [x, y] of chart.dots) {
      expect(x).toBeGreaterThanOrEqual(chart.plot.left);
      expect(x).toBeLessThanOrEqual(chart.plot.right);
      expect(y).toBeGreaterThanOrEqual(chart.plot.top);
      expect(y).toBeLessThanOrEqual(chart.plot.bottom);
    }
    expect(chart.dots[0]?.[1]).toBeGreaterThan(chart.dots[2]?.[1] ?? 0);
    expect(chart.line).not.toBeNull();
    expect(chart.xTicks.map((t) => t.label)).toEqual(['950 h', '1,225 h', '1,500 h', '1,775 h', '2,050 h']);
    expect(chart.yTicks.map((t) => t.label)).toEqual(['-10', '0', '10']);
  });

  it('시간 축은 MM-DD, 점이 2개 미만이면 null', () => {
    const day = Date.UTC(2026, 7, 31, 15);
    const chart = buildSeriesChart({ xKind: 'time', yName: '%', points: [[day, 97], [day + 10 * 86_400_000, 96]], line: null }, { width: 300, height: 120 });
    expect(chart?.xTicks.map((t) => t.label)).toEqual(['08-31', '09-03', '09-06', '09-08', '09-11']);
    expect(buildSeriesChart({ xKind: 'time', yName: '%', points: [[day, 1]], line: null }, { width: 300, height: 120 })).toBeNull();
  });
});

describe('buildBarChart', () => {
  it('0 기준선을 포함하고 음수 막대는 기준선 아래로, 모두 0이거나 비면 null', () => {
    const chart = buildBarChart([{ label: '생산', value: 1200 }, { label: '저장 증감', value: -150 }, { label: '잔차', value: 30 }], { width: 300, height: 160 });
    expect(chart).not.toBeNull();
    if (!chart) return;
    const [produced, stored, residual] = chart.bars;
    expect(produced && produced.y + produced.height).toBeCloseTo(chart.baseline, 1);
    expect(stored?.negative).toBe(true);
    expect(stored?.y).toBeCloseTo(chart.baseline, 1);
    expect((produced?.height ?? 0) > (residual?.height ?? 0)).toBe(true);
    expect(chart.yTicks.map((t) => t.label)).toEqual(['-500', '0', '500', '1,000', '1,500']);
    expect(buildBarChart([{ label: 'a', value: 0 }], { width: 300, height: 160 })).toBeNull();
    expect(buildBarChart([], { width: 300, height: 160 })).toBeNull();
  });
});
