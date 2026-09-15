// 센서 계층: 정규값(canonical)에 노이즈 → 스파이크 → 원본 단위 변환 → 반올림 → 고착을 적용한다.
import type { MetricDef, PointDef } from '@/db/seed/types';
import { clamp, roundTo } from './math';
import type { Rng } from './rng';

interface NoiseSpec {
  /** 값 비례 표준편차 */
  readonly relative: number;
  /** 절대 표준편차 (0이면 참값 0은 0으로 남는다: 밤 PV 0, 정지 전류 0) */
  readonly absolute: number;
}

const QUANTITY_NOISE: Readonly<Record<string, NoiseSpec>> = {
  irradiance: { relative: 0.005, absolute: 1 },
  temperature: { relative: 0, absolute: 0.15 },
  humidity: { relative: 0, absolute: 0.8 },
  speed: { relative: 0.05, absolute: 0.1 },
  voltage: { relative: 0.001, absolute: 0 },
  current: { relative: 0.003, absolute: 0 },
  power: { relative: 0.003, absolute: 0 },
  frequency: { relative: 0, absolute: 0.005 },
  power_factor: { relative: 0, absolute: 0.002 },
  state_of_charge: { relative: 0, absolute: 0.05 },
  resistance: { relative: 0.02, absolute: 0 },
  pressure: { relative: 0.002, absolute: 0.02 },
  mass_flow: { relative: 0.005, absolute: 0 },
  mass: { relative: 0.003, absolute: 0 },
  purity: { relative: 0, absolute: 0.001 },
  concentration: { relative: 0.01, absolute: 1.5 },
  dewpoint: { relative: 0, absolute: 0.3 },
  conductivity: { relative: 0.02, absolute: 0 },
  volume_flow: { relative: 0.01, absolute: 0 },
  level: { relative: 0, absolute: 0.3 },
  efficiency: { relative: 0, absolute: 0.05 },
  velocity: { relative: 0.08, absolute: 0 },
};
const NO_NOISE: NoiseSpec = { relative: 0, absolute: 0 };
const DEFAULT_NOISE: NoiseSpec = { relative: 0.002, absolute: 0 };
/** 셀 전압 통계(max/min/avg)는 서로 순서가 뒤집히지 않도록 0.2 mV 수준으로 작게 둔다 */
const CELL_VOLTAGE_NOISE: NoiseSpec = { relative: 0.000_05, absolute: 0 };

/**
 * 저장용기 압력·온도 센서 잡음 (1σ): 압력 전송기 ±0.1% FS(FS 500 bar → 0.5 bar), 온도 ±0.3 °C.
 * 용기별 고정 교정 오프셋은 plant-hydrogen이 따로 더한다.
 */
export const TANK_SENSOR_NOISE = Object.freeze({ pressureFullScaleBar: 500, pressurePctFs: 0.1, tempC: 0.3 });
const TANK_NOISE: Readonly<Record<string, NoiseSpec>> = {
  'tank.pressure': { relative: 0, absolute: (TANK_SENSOR_NOISE.pressureFullScaleBar * TANK_SENSOR_NOISE.pressurePctFs) / 100 },
  'tank.temp': { relative: 0, absolute: TANK_SENSOR_NOISE.tempC },
};

/** 원본 단위별 소수 자릿수 (정규 단위와 다를 때) */
const SOURCE_UNIT_DECIMALS: Readonly<Record<string, number>> = { mV: 1, 'MΩ': 3, MPa: 3, K: 2 };
const QUANTITY_DECIMALS: Readonly<Record<string, number>> = {
  irradiance: 1,
  temperature: 2,
  humidity: 1,
  speed: 2,
  voltage: 2,
  current: 2,
  power: 2,
  reactive_power: 2,
  energy: 1,
  frequency: 3,
  power_factor: 3,
  ratio: 1,
  state: 0,
  count: 0,
  duration: 3,
  state_of_charge: 2,
  state_of_health: 2,
  resistance: 0,
  pressure: 2,
  mass_flow: 4,
  mass: 3,
  purity: 4,
  dewpoint: 1,
  conductivity: 3,
  volume_flow: 3,
  level: 1,
  efficiency: 2,
  velocity: 2,
};

/** 원본 태그 규약: 정규값 = raw × scale + valueOffset → raw = (정규값 − valueOffset) / scale */
export function toRawValue(point: Pick<PointDef, 'scale' | 'valueOffset'>, canonical: number): number {
  return (canonical - point.valueOffset) / point.scale;
}

function noiseSpecFor(metric: MetricDef): NoiseSpec {
  if (metric.valueKind !== 'gauge') return NO_NOISE;
  if (metric.key.startsWith('cell.voltage.')) return CELL_VOLTAGE_NOISE;
  const tank = TANK_NOISE[metric.key];
  if (tank) return tank;
  return QUANTITY_NOISE[metric.quantity] ?? (metric.quantity === 'ratio' || metric.quantity === 'state_of_health' ? NO_NOISE : DEFAULT_NOISE);
}

export function decimalsFor(metric: MetricDef, sourceUnit: string): number {
  if (metric.unit !== sourceUnit) return SOURCE_UNIT_DECIMALS[sourceUnit] ?? 4;
  if (metric.unit === '%' && metric.quantity === 'concentration') return 3;
  return QUANTITY_DECIMALS[metric.quantity] ?? 3;
}

/** 노이즈 후 hard 범위로 자른다: 건강한 데이터가 범위 이탈 품질 비트를 받지 않게 한다. */
export function addNoise(metric: MetricDef, canonical: number, rng: Rng): number {
  const spec = noiseSpecFor(metric);
  const sd = spec.relative * Math.abs(canonical) + spec.absolute;
  const noisy = sd > 0 ? canonical + sd * rng.gaussian() : canonical;
  return clamp(noisy, metric.hardMin ?? -Infinity, metric.hardMax ?? Infinity);
}

/** 스파이크: 값 ± max(|값|, 기대범위 폭의 10%, 1) × magnitude */
export function spikeValue(metric: MetricDef, value: number, magnitude: number, rng: Rng): number {
  const span = metric.expectedMax !== null && metric.expectedMin !== null ? metric.expectedMax - metric.expectedMin : 0;
  const base = Math.max(Math.abs(value), span * 0.1, 1);
  const sign = rng.chance(0.5) ? 1 : -1;
  return value + sign * base * magnitude;
}

export function formatRaw(metric: MetricDef, point: Pick<PointDef, 'scale' | 'valueOffset' | 'sourceUnit'>, canonical: number): number {
  return roundTo(toRawValue(point, canonical), decimalsFor(metric, point.sourceUnit));
}
