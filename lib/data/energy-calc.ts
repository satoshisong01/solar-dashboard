// m_1h 시간 롤업으로 구간 에너지·수소량을 계산하는 순수 함수와 KPI 정의.
import type { TimeWindow } from './time';

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

const byBucket = (a: HourBucket, b: HourBucket) => a.bucketMs - b.bucketMs;

/**
 * 누적 카운터의 구간 증가량. 연속한 시간 버킷의 마지막 값 차이를 더한다.
 * 기준값은 구간 직전 버킷의 마지막 값, 없으면 구간 첫 버킷의 첫 값이다.
 * 값이 줄면(카운터 리셋·교체) 그 단계는 0으로 본다. 구간에 값이 하나도 없으면 null.
 */
export function counterIncrease(buckets: readonly HourBucket[], window: TimeWindow): number | null {
  const ordered = [...buckets].sort(byBucket);
  const before = ordered.filter((b) => b.bucketMs < window.fromMs && b.last !== null);
  const inside = ordered.filter((b) => b.bucketMs >= window.fromMs && b.bucketMs < window.toMs && b.last !== null);
  if (inside.length === 0) return null;

  const baseline = before.at(-1)?.last ?? inside[0].first ?? inside[0].last;
  let previous = baseline ?? 0;
  let total = 0;
  for (const bucket of inside) {
    const last = bucket.last ?? previous;
    total += Math.max(0, last - previous);
    previous = last;
  }
  return total;
}

/** 시간 평균 전력(kW) × 1시간을 더한 에너지(kWh). 값이 있는 버킷만 더하고, 하나도 없으면 null */
export function hourlyAverageEnergy(buckets: readonly HourBucket[], window: TimeWindow): number | null {
  const inside = buckets.filter((b) => b.bucketMs >= window.fromMs && b.bucketMs < window.toMs && b.avg !== null);
  if (inside.length === 0) return null;
  return inside.reduce((total, b) => total + (b.avg ?? 0) * BUCKET_HOURS, 0);
}

export function computeEnergy(method: EnergyMethod, buckets: readonly HourBucket[], window: TimeWindow): number | null {
  return method === 'counter' ? counterIncrease(buckets, window) : hourlyAverageEnergy(buckets, window);
}

/** 모두 null이면 null, 아니면 null을 뺀 합 */
export function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}
