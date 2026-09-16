// 지도 상세 패널의 수치 타일 4개와 오늘 발전 곡선. 순수 모듈 (서버·클라이언트 공용).
// 값은 m_1h 롤업에서 lib/data/energy-calc.ts의 계산식으로 구하고, 없는 값은 지어내지 않고 present/value로 구분해 내보낸다.
import { computeEnergy, sumNullable, type EnergyKpiDef, type HourBucket } from './energy-calc';
import { HOUR_MS, type TimeWindow } from './time';

/** present: 사이트에 이 지표의 원천 포인트가 있는가 (없으면 '해당 없음') / value: 값, 수신이 없으면 null ('데이터 없음') */
export interface MapMetricValue {
  readonly present: boolean;
  readonly value: number | null;
}

export const ABSENT: MapMetricValue = { present: false, value: null };

/** 지도 타일이 쓰는 원천 지표. 앞의 다섯은 lib/data/energy-calc.ts ENERGY_KPIS와 같은 정의다 */
export const MAP_METRICS = Object.freeze({
  pvKwh: { classKey: 'pv.inverter', metricKey: 'ac.energy.total', method: 'counter' },
  essChargeKwh: { classKey: 'ess.pcs', metricKey: 'ac.energy.charge.total', method: 'counter' },
  essDischargeKwh: { classKey: 'ess.pcs', metricKey: 'ac.energy.discharge.total', method: 'counter' },
  h2Kg: { classKey: 'h2.elz', metricKey: 'h2.mass.total', method: 'counter' },
  fcKwh: { classKey: 'fc.plant', metricKey: 'fc.ac.power', method: 'hourly_avg' },
  gridExportKwh: { classKey: 'grid.meter', metricKey: 'ac.energy.export.total', method: 'counter' },
  gridImportKwh: { classKey: 'grid.meter', metricKey: 'ac.energy.import.total', method: 'counter' },
  /** 시간 평균 일사(W/m²)를 더한 것 = Wh/m². 1,000으로 나누면 kWh/m² */
  poaWhM2: { classKey: 'wx.station', metricKey: 'poa.irradiance', method: 'hourly_avg' },
} as const satisfies Readonly<Record<string, EnergyKpiDef>>);

export type MapMetricKey = keyof typeof MAP_METRICS;
export const MAP_METRIC_KEYS = Object.keys(MAP_METRICS) as MapMetricKey[];

export type MapMetrics = Readonly<Record<MapMetricKey, MapMetricValue>>;

export const EMPTY_MAP_METRICS: MapMetrics = Object.freeze(
  Object.fromEntries(MAP_METRIC_KEYS.map((key) => [key, ABSENT])) as Record<MapMetricKey, MapMetricValue>,
);

export interface MapKpiTile {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  /** 소수 자릿수 상한 */
  readonly digits: number;
  /** 물음표 없이 한 줄로 읽는 계산 설명 */
  readonly note: string;
  readonly present: boolean;
  readonly value: number | null;
}

type Tile = Readonly<{ key: string; label: string; unit: string; digits: number; note: string }>;

const TILES = Object.freeze({
  pv: { key: 'pv', label: '발전량', unit: 'kWh', digits: 0, note: '인버터 누적 전력량 증가분' },
  h2: { key: 'h2', label: '수소 생산', unit: 'kg', digits: 1, note: '전해조 누적 생산량 증가분' },
  export: { key: 'export', label: '계통 수출', unit: 'kWh', digits: 0, note: '계량기 역송 누적량 증가분' },
  selfUse: { key: 'selfUse', label: '자가 소비', unit: 'kWh', digits: 0, note: '발전·방전·수전에서 역송과 충전을 뺀 값' },
  pr: { key: 'pr', label: '성능지수', unit: '%', digits: 1, note: '발전량 ÷ (설비용량 × 경사면 일사)' },
  fc: { key: 'fc', label: '연료전지 발전', unit: 'kWh', digits: 0, note: '시간 평균 출력의 합' },
} as const satisfies Readonly<Record<string, Tile>>);

const tile = (spec: Tile, value: MapMetricValue): MapKpiTile => ({ ...spec, present: value.present, value: value.value });

/**
 * 자가 소비 [kWh] = (태양광 + 연료전지 + ESS 방전 + 계통 수전) − (계통 역송 + ESS 충전).
 * 계량기(역송·수전)가 없으면 사이트가 실제로 쓴 양을 알 수 없으므로 '해당 없음'으로 둔다.
 */
export function selfUseKwh(metrics: MapMetrics): MapMetricValue {
  const supply: MapMetricKey[] = ['pvKwh', 'fcKwh', 'essDischargeKwh', 'gridImportKwh'];
  const sink: MapMetricKey[] = ['gridExportKwh', 'essChargeKwh'];
  if (!metrics.gridExportKwh.present || !metrics.gridImportKwh.present) return ABSENT;
  const value = sumNullable([
    ...supply.map((key) => metrics[key].value),
    ...sink.map((key) => (metrics[key].value === null ? null : -(metrics[key].value as number))),
  ]);
  return { present: true, value: value === null ? null : Math.max(0, value) };
}

/**
 * 성능지수 PR [%] = 발전량 ÷ (직류 정격용량 × 경사면 일사 kWh/m²).
 * 정격용량이나 일사계가 없으면 '해당 없음'.
 */
export function performanceRatioPct(metrics: MapMetrics, dcKwp: number | null): MapMetricValue {
  if (!metrics.pvKwh.present || !metrics.poaWhM2.present || dcKwp === null || !(dcKwp > 0)) return ABSENT;
  const poaKwhM2 = metrics.poaWhM2.value === null ? null : metrics.poaWhM2.value / 1_000;
  if (metrics.pvKwh.value === null || poaKwhM2 === null || !(poaKwhM2 > 0)) return { present: true, value: null };
  return { present: true, value: (metrics.pvKwh.value / (dcKwp * poaKwhM2)) * 100 };
}

/**
 * 타일 4개. 태양광이 있는 사이트는 발전 → 팔고 → 쓰고 → 얼마나 잘 냈나 순서로,
 * 태양광이 없는 사이트(수소 전용 등)는 첫 칸과 끝 칸을 그 설비의 지표로 바꾼다.
 */
export function mapKpiTiles(metrics: MapMetrics, dcKwp: number | null): readonly MapKpiTile[] {
  const selfUse = tile(TILES.selfUse, selfUseKwh(metrics));
  const gridExport = tile(TILES.export, metrics.gridExportKwh);
  if (metrics.pvKwh.present) {
    return [tile(TILES.pv, metrics.pvKwh), gridExport, selfUse, tile(TILES.pr, performanceRatioPct(metrics, dcKwp))];
  }
  return [tile(TILES.h2, metrics.h2Kg), gridExport, selfUse, tile(TILES.fc, metrics.fcKwh)];
}

export interface CurvePoint {
  readonly hourMs: number;
  readonly value: number | null;
}

/** 시간대별 값 (1시간 버킷). 구간이 비어 있으면 빈 배열 */
export function hourlyCurve(method: EnergyKpiDef['method'], bucketsByPoint: readonly (readonly HourBucket[])[], window: TimeWindow): readonly CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let hourMs = window.fromMs; hourMs < window.toMs; hourMs += HOUR_MS) {
    const hour: TimeWindow = { fromMs: hourMs, toMs: hourMs + HOUR_MS };
    points.push({ hourMs, value: sumNullable(bucketsByPoint.map((buckets) => computeEnergy(method, buckets, hour))) });
  }
  return points;
}

/** 값이 하나라도 있는가 (없으면 화면은 빈 상태 문구를 쓴다) */
export const curveHasData = (curve: readonly CurvePoint[]): boolean => curve.some((point) => point.value !== null);
