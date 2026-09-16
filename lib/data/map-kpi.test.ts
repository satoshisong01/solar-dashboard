import { describe, expect, it } from 'vitest';
import type { HourBucket } from './energy-calc';
import {
  ABSENT,
  EMPTY_MAP_METRICS,
  curveHasData,
  hourlyCurve,
  mapKpiTiles,
  performanceRatioPct,
  selfUseKwh,
  type MapMetrics,
} from './map-kpi';
import { HOUR_MS } from './time';

const value = (v: number | null) => ({ present: true, value: v });
const metrics = (over: Partial<MapMetrics> = {}): MapMetrics => ({ ...EMPTY_MAP_METRICS, ...over });

describe('selfUseKwh', () => {
  it('발전·방전·수전에서 역송·충전을 뺀다', () => {
    const result = selfUseKwh(
      metrics({
        pvKwh: value(1_000),
        fcKwh: value(100),
        essDischargeKwh: value(200),
        gridImportKwh: value(50),
        gridExportKwh: value(600),
        essChargeKwh: value(250),
      }),
    );
    expect(result).toEqual({ present: true, value: 500 });
  });

  it('계량기가 없으면 사이트가 쓴 양을 알 수 없어 해당 없음', () => {
    expect(selfUseKwh(metrics({ pvKwh: value(1_000), gridExportKwh: value(10) }))).toEqual(ABSENT);
    expect(selfUseKwh(metrics({ pvKwh: value(1_000), gridImportKwh: value(10) }))).toEqual(ABSENT);
  });

  it('계량기는 있는데 수신이 없으면 데이터 없음(null)이고, 음수는 0으로 막는다', () => {
    const meters = { gridExportKwh: value(null), gridImportKwh: value(null) };
    expect(selfUseKwh(metrics(meters))).toEqual({ present: true, value: null });
    expect(selfUseKwh(metrics({ ...meters, gridExportKwh: value(900), pvKwh: value(100) }))).toEqual({ present: true, value: 0 });
  });
});

describe('performanceRatioPct', () => {
  it('발전량 ÷ (정격용량 × 경사면 일사)', () => {
    // 1,000 kWp · 5 kWh/m² · 4,000 kWh → PR 80%
    const result = performanceRatioPct(metrics({ pvKwh: value(4_000), poaWhM2: value(5_000) }), 1_000);
    expect(result.present).toBe(true);
    expect(result.value).toBeCloseTo(80, 6);
  });

  it('일사계나 정격용량이 없으면 해당 없음', () => {
    expect(performanceRatioPct(metrics({ pvKwh: value(4_000), poaWhM2: value(5_000) }), null)).toEqual(ABSENT);
    expect(performanceRatioPct(metrics({ pvKwh: value(4_000), poaWhM2: value(5_000) }), 0)).toEqual(ABSENT);
    expect(performanceRatioPct(metrics({ pvKwh: value(4_000) }), 1_000)).toEqual(ABSENT);
  });

  it('밤이라 일사가 0이면 나누지 않고 데이터 없음으로 둔다', () => {
    expect(performanceRatioPct(metrics({ pvKwh: value(0), poaWhM2: value(0) }), 1_000)).toEqual({ present: true, value: null });
    expect(performanceRatioPct(metrics({ pvKwh: value(null), poaWhM2: value(5_000) }), 1_000)).toEqual({ present: true, value: null });
  });
});

describe('mapKpiTiles', () => {
  it('태양광이 있으면 발전량·계통 수출·자가 소비·성능지수', () => {
    const tiles = mapKpiTiles(metrics({ pvKwh: value(4_000), poaWhM2: value(5_000), gridExportKwh: value(3_000), gridImportKwh: value(0) }), 1_000);
    expect(tiles.map((t) => t.label)).toEqual(['발전량', '계통 수출', '자가 소비', '성능지수']);
    expect(tiles.map((t) => t.unit)).toEqual(['kWh', 'kWh', 'kWh', '%']);
    expect(tiles[0].value).toBe(4_000);
    expect(tiles[2].value).toBe(1_000);
  });

  it('태양광이 없는 사이트는 첫 칸과 끝 칸이 수소 생산·연료전지 발전으로 바뀐다', () => {
    const tiles = mapKpiTiles(metrics({ h2Kg: value(42.5), fcKwh: value(120) }), null);
    expect(tiles.map((t) => t.label)).toEqual(['수소 생산', '계통 수출', '자가 소비', '연료전지 발전']);
    expect(tiles[0].value).toBe(42.5);
    expect(tiles[3].value).toBe(120);
  });

  it('원천이 없는 지표는 present=false로 남아 화면이 해당 없음을 쓴다 (0으로 꾸미지 않는다)', () => {
    const tiles = mapKpiTiles(EMPTY_MAP_METRICS, null);
    expect(tiles).toHaveLength(4);
    expect(tiles.every((t) => !t.present && t.value === null)).toBe(true);
  });
});

const bucket = (bucketMs: number, last: number): HourBucket => ({ bucketMs, first: last, last, avg: last });

describe('hourlyCurve', () => {
  const start = Date.UTC(2026, 8, 15, 0, 0);
  const window = { fromMs: start, toMs: start + 3 * HOUR_MS };

  it('누적 카운터를 시간대별 증가분으로 바꾸고 포인트를 합한다', () => {
    const a = [bucket(start - HOUR_MS, 100), bucket(start, 110), bucket(start + HOUR_MS, 135), bucket(start + 2 * HOUR_MS, 135)];
    const b = [bucket(start - HOUR_MS, 0), bucket(start, 5), bucket(start + HOUR_MS, 15), bucket(start + 2 * HOUR_MS, 20)];
    expect(hourlyCurve('counter', [a, b], window)).toEqual([
      { hourMs: start, value: 15 },
      { hourMs: start + HOUR_MS, value: 35 },
      { hourMs: start + 2 * HOUR_MS, value: 5 },
    ]);
  });

  it('수신이 없는 시간대는 null이고, 모두 null이면 빈 상태로 본다', () => {
    const only = [[bucket(start - HOUR_MS, 10), bucket(start, 12)]];
    const curve = hourlyCurve('counter', only, window);
    expect(curve.map((p) => p.value)).toEqual([2, null, null]);
    expect(curveHasData(curve)).toBe(true);
    expect(curveHasData(hourlyCurve('counter', [], window))).toBe(false);
    expect(hourlyCurve('counter', [], { fromMs: start, toMs: start })).toEqual([]);
  });
});
