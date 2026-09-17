// m_1h 시간 롤업으로 구간 에너지·수소량을 계산하는 순수 함수와 KPI 정의.
import { HOUR_MS, type TimeWindow } from './time';

/** m_1h 버킷 길이(시간) */
const BUCKET_HOURS = 1;

export interface HourBucket {
  readonly bucketMs: number;
  readonly first: number | null;
  readonly last: number | null;
  readonly avg: number | null;
}

export type EnergyMethod = 'counter' | 'hourly_avg';

export interface EnergyKpiDef {
  readonly classKey: string;
  readonly metricKey: string;
  /** counter: 누적 카운터 증가량 / hourly_avg: 시간 평균 전력 × 1시간 합 (카운터가 없는 설비) */
  readonly method: EnergyMethod;
}

/** 구간 에너지 계산 결과: 값과 함께 '값에 넣지 않은 것'을 알린다 (조용히 버리지 않는다) */
export interface EnergyResult {
  /** 구간 값. 구간에 쓸 값이 하나도 없으면 null */
  readonly value: number | null;
  /** 설비 정격으로 설명되지 않는 카운터 점프가 있어 그 단계를 빼고 더했다 */
  readonly suspect: boolean;
  /** 값에 넣지 않은 정지 중 대기 소비 [kWh·kg] (양수 크기). 카운터 방식은 늘 0 */
  readonly standby: number;
}

const EMPTY: EnergyResult = Object.freeze({ value: null, suspect: false, standby: 0 });

/** 대시보드·사이트 KPI의 발전·수소 요약 정의. 같은 종류의 설비가 여럿이면 합한다 */
export const ENERGY_KPIS = Object.freeze({
  pvKwh: { classKey: 'pv.inverter', metricKey: 'ac.energy.total', method: 'counter' },
  essChargeKwh: { classKey: 'ess.pcs', metricKey: 'ac.energy.charge.total', method: 'counter' },
  essDischargeKwh: { classKey: 'ess.pcs', metricKey: 'ac.energy.discharge.total', method: 'counter' },
  h2Kg: { classKey: 'h2.elz', metricKey: 'h2.mass.total', method: 'counter' },
  fcKwh: { classKey: 'fc.plant', metricKey: 'fc.ac.power', method: 'hourly_avg' },
} as const satisfies Readonly<Record<string, EnergyKpiDef>>);

export type EnergyKpiKey = keyof typeof ENERGY_KPIS;
export const ENERGY_KPI_KEYS = Object.keys(ENERGY_KPIS) as EnergyKpiKey[];

/**
 * 카운터 KPI의 시간당 최대 증가량을 읽는 설비 명판 키.
 * 적산 카운터는 교체·재기동으로 값이 점프하는데, 감소만 막으면 그 점프가 그대로 구간 에너지로 더해진다
 * (1 MW PCS가 한 시간에 27 MWh를 충전한 것처럼 보이는 식). 정격은 이력과 달리 새 사이트에서도 쓸 수 있고,
 * 설비가 물리적으로 넘을 수 없는 선이라 '직전 N일 중앙값의 k배'보다 판단 근거가 분명해 이쪽을 쓴다.
 */
export const ENERGY_RATE_LIMIT_KEYS: Readonly<Partial<Record<EnergyKpiKey, string>>> = Object.freeze({
  pvKwh: 'ac_kw',
  essChargeKwh: 'power_kw',
  essDischargeKwh: 'power_kw',
  h2Kg: 'h2_rated_kg_h',
});

const byBucket = (a: HourBucket, b: HourBucket) => a.bucketMs - b.bucketMs;

/**
 * 한 단계(직전 버킷의 마지막 값 → 이 버킷의 마지막 값)가 덮을 수 있는 최대 시간.
 * 두 마지막 샘플은 각자의 버킷 안 아무 데나 놓이므로 버킷 시작 간격보다 최대 1시간 더 벌어질 수 있다.
 */
const stepHours = (previousMs: number, bucketMs: number): number => (bucketMs - previousMs) / HOUR_MS + BUCKET_HOURS;

/**
 * 누적 카운터의 구간 증가량. 연속한 시간 버킷의 마지막 값 차이를 더한다.
 * 기준값은 구간 직전 버킷의 마지막 값, 없으면 구간 첫 버킷의 첫 값이다.
 * 값이 줄면(카운터 리셋·교체) 그 단계는 0으로 본다. 구간에 값이 하나도 없으면 값이 null.
 *
 * maxPerHour(설비 정격)를 주면 그 속도로도 설명되지 않는 단계는 설비가 낸 에너지가 아니므로
 * 더하지 않고 suspect로 알린다 — 값에서 조용히 빼면 화면이 멀쩡한 숫자를 보여 주게 된다.
 */
export function counterIncrease(buckets: readonly HourBucket[], window: TimeWindow, maxPerHour: number | null = null): EnergyResult {
  const ordered = [...buckets].sort(byBucket);
  const before = ordered.filter((b) => b.bucketMs < window.fromMs && b.last !== null);
  const inside = ordered.filter((b) => b.bucketMs >= window.fromMs && b.bucketMs < window.toMs && b.last !== null);
  if (inside.length === 0) return EMPTY;

  const previousBucket = before.at(-1);
  let previous = previousBucket?.last ?? inside[0].first ?? inside[0].last ?? 0;
  let previousMs = previousBucket?.bucketMs ?? inside[0].bucketMs;
  let total = 0;
  let suspect = false;
  for (const bucket of inside) {
    const last = bucket.last ?? previous;
    if (maxPerHour !== null && last - previous > maxPerHour * stepHours(previousMs, bucket.bucketMs)) suspect = true;
    else total += Math.max(0, last - previous);
    previous = last;
    previousMs = bucket.bucketMs;
  }
  return { value: total, suspect, standby: 0 };
}

/**
 * 시간 평균 전력(kW) × 1시간을 더한 에너지(kWh). 값이 있는 버킷만 더하고, 하나도 없으면 값이 null.
 * 정지 중 대기 소비로 평균이 음수인 버킷은 발전량이 아니므로 값에 넣지 않고 standby로 따로 센다
 * (그냥 더하면 하루 종일 정지한 연료전지가 −7 kWh를 '발전'한 것처럼 보인다).
 */
export function hourlyAverageEnergy(buckets: readonly HourBucket[], window: TimeWindow): EnergyResult {
  const inside = buckets.filter((b) => b.bucketMs >= window.fromMs && b.bucketMs < window.toMs && b.avg !== null);
  if (inside.length === 0) return EMPTY;
  const energies = inside.map((b) => (b.avg ?? 0) * BUCKET_HOURS);
  return {
    value: energies.reduce((total, kwh) => total + Math.max(0, kwh), 0),
    suspect: false,
    standby: Math.abs(energies.reduce((total, kwh) => total + Math.min(0, kwh), 0)),
  };
}

export function computeEnergy(method: EnergyMethod, buckets: readonly HourBucket[], window: TimeWindow, maxPerHour: number | null = null): EnergyResult {
  return method === 'counter' ? counterIncrease(buckets, window, maxPerHour) : hourlyAverageEnergy(buckets, window);
}

/** 같은 KPI의 설비별 결과를 합친다. 값은 모두 null일 때만 null, 하나라도 의심이면 의심 */
export function sumEnergyResults(results: readonly EnergyResult[]): EnergyResult {
  return {
    value: sumNullable(results.map((result) => result.value)),
    suspect: results.some((result) => result.suspect),
    standby: results.reduce((total, result) => total + result.standby, 0),
  };
}

/** 설비 명판에서 시간당 최대 증가량을 읽는다. 값이 없거나 양수가 아니면 상한을 두지 않는다 */
export function ratedPerHour(nameplate: unknown, kpi: EnergyKpiKey): number | null {
  const key = ENERGY_RATE_LIMIT_KEYS[kpi];
  if (key === undefined || nameplate === null || typeof nameplate !== 'object' || Array.isArray(nameplate)) return null;
  const rated = (nameplate as Readonly<Record<string, unknown>>)[key];
  return typeof rated === 'number' && Number.isFinite(rated) && rated > 0 ? rated : null;
}

/** 모두 null이면 null, 아니면 null을 뺀 합 */
export function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}
