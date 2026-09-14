// 일 KPI 순수 계산 (om.kpi_daily 한 행 = KpiValue 하나). 입력은 m_1h 요약 행 또는 에피소드.
// kpi_key는 DB 제약(^[a-z][a-z0-9]*(\.[a-z0-9_]+)*$)에 맞춰 점 구분 이름을 쓴다 (예: pv_kwh → 'pv.kwh').
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import type { PvDayEpisode } from '../episodes/pv';
import { median } from '../stats/robust';

export const KPI_CALC_VERSION = 'kpi@1';

export const KPI_KEYS = Object.freeze({
  pv_kwh: 'pv.kwh',
  specific_yield_kwh_kwp: 'pv.specific_yield_kwh_kwp',
  inverter_peer_ratio: 'pv.inverter_peer_ratio',
  ess_rte: 'ess.rte',
  elz_sec_kwh_per_kg: 'elz.sec_kwh_per_kg',
  elz_v_cell_ref: 'elz.v_cell_ref',
  fc_kg_per_mwh: 'fc.kg_per_mwh',
  fc_v_cell_ref: 'fc.v_cell_ref',
  availability: 'availability',
} as const);

export type KpiKey = (typeof KPI_KEYS)[keyof typeof KPI_KEYS];

export interface KpiValue {
  readonly key: KpiKey;
  /** null = 데이터 부족으로 계산하지 않음 */
  readonly value: number | null;
  readonly unit: string;
  readonly n: number;
  readonly dqCompleteness: number | null;
}

/** om.m_1h 한 행 (필요한 열만) */
export interface HourlyRow {
  readonly hourStart: number;
  readonly n: number;
  readonly nGood: number;
  readonly avg: number | null;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const kpi = (key: KpiKey, value: number | null, unit: string, n: number, dqCompleteness: number | null): KpiValue => ({ key, value, unit, n, dqCompleteness });

/** 인버터 하루 발전량 [kWh] = Σ 시간 평균 kW × 1h. 완결성 = Σ n_good / (24 × 시간당 기대 샘플 수) */
export function pvKwh(rows: readonly HourlyRow[], expectedSamplesPerHour: number): KpiValue {
  const usable = rows.filter((r) => r.nGood > 0 && r.avg !== null);
  const dq = clamp01(rows.reduce((sum, r) => sum + r.nGood, 0) / (24 * expectedSamplesPerHour));
  if (usable.length === 0) return kpi(KPI_KEYS.pv_kwh, null, 'kWh', 0, dq);
  return kpi(KPI_KEYS.pv_kwh, usable.reduce((sum, r) => sum + Math.max(0, r.avg ?? 0), 0), 'kWh', usable.length, dq);
}

/** 사이트·인버터 비발전량 [kWh/kWp] */
export function specificYield(energy: KpiValue, dcKwp: number): KpiValue {
  const value = energy.value === null || !(dcKwp > 0) ? null : energy.value / dcKwp;
  return kpi(KPI_KEYS.specific_yield_kwh_kwp, value, 'kWh/kWp', energy.n, energy.dqCompleteness);
}

export interface InverterDayEnergy {
  readonly assetId: number;
  readonly kwh: number | null;
  readonly dcKwp: number;
}

/** 인버터별 (kWh/kWp) ÷ 사이트 동종 중앙값. 값이 있는 인버터가 3대 미만이면 모두 null */
export function inverterPeerRatios(inverters: readonly InverterDayEnergy[], minPeers = 3): ReadonlyMap<number, KpiValue> {
  const yields = inverters.flatMap((inv) => (inv.kwh !== null && inv.dcKwp > 0 ? [{ assetId: inv.assetId, y: inv.kwh / inv.dcKwp }] : []));
  const peerMedian = yields.length >= minPeers ? median(yields.map((v) => v.y)) : null;
  return new Map(
    inverters.map((inv) => {
      const own = yields.find((v) => v.assetId === inv.assetId);
      const value = own && peerMedian !== null && peerMedian > 0 ? own.y / peerMedian : null;
      return [inv.assetId, kpi(KPI_KEYS.inverter_peer_ratio, value, '', yields.length, null)] as const;
    }),
  );
}

export interface EssDayEnergy {
  readonly chargeKwh: number;
  readonly dischargeKwh: number;
  readonly socStartPct: number | null;
  readonly socEndPct: number | null;
  readonly usableKwh: number;
  readonly dqCompleteness: number;
}

/**
 * ESS 왕복효율 = 방전 kWh / (충전 kWh − 저장량 변화). 저장량 변화 = (SOC 끝 − 시작)/100 × 가용 kWh.
 * 충전량이 가용 용량의 minChargeFraction 미만이면 null (분모가 작아 흔들림).
 */
export function essRte(day: EssDayEnergy, minChargeFraction = 0.2): KpiValue {
  const stored = day.socStartPct === null || day.socEndPct === null ? null : ((day.socEndPct - day.socStartPct) / 100) * day.usableKwh;
  const denominator = stored === null ? null : day.chargeKwh - stored;
  const enough = day.chargeKwh >= minChargeFraction * day.usableKwh && denominator !== null && denominator > 0;
  return kpi(KPI_KEYS.ess_rte, enough && denominator !== null ? day.dischargeKwh / denominator : null, '', 1, day.dqCompleteness);
}

const meanCompleteness = (episodes: readonly { readonly dq: { readonly completeness: number } }[]): number | null =>
  episodes.length === 0 ? null : episodes.reduce((sum, e) => sum + e.dq.completeness, 0) / episodes.length;

/** 전해조 비에너지 소비 [kWh/kg] = Σ 에너지 / Σ 수소 (유효 정상운전 구간) */
export function elzSec(episodes: readonly ElSteadyEpisode[]): KpiValue {
  const usable = episodes.filter((e) => e.valid && e.features.energy_kwh !== null && e.features.h2_kg !== null && e.features.h2_kg > 0);
  const energy = usable.reduce((sum, e) => sum + (e.features.energy_kwh ?? 0), 0);
  const h2 = usable.reduce((sum, e) => sum + (e.features.h2_kg ?? 0), 0);
  return kpi(KPI_KEYS.elz_sec_kwh_per_kg, h2 > 0 ? energy / h2 : null, 'kWh/kg', usable.length, meanCompleteness(usable));
}

export interface ReferenceCondition {
  readonly jRefAcm2: number;
  readonly jToleranceAcm2: number;
}

/** 전해조 기준 전류밀도 셀 전압 [V] = 기준 ±허용 안 정상운전 v_cell_mean의 중앙값 */
export function elzVCellRef(episodes: readonly ElSteadyEpisode[], condition: ReferenceCondition): KpiValue {
  const near = episodes.filter((e) => e.valid && e.features.v_cell_mean !== null && Math.abs(e.features.j_mean - condition.jRefAcm2) <= condition.jToleranceAcm2);
  const value = near.length === 0 ? null : median(near.map((e) => e.features.v_cell_mean ?? 0));
  return kpi(KPI_KEYS.elz_v_cell_ref, value, 'V', near.length, meanCompleteness(near));
}

/** 연료전지 수소 원단위 [kg/MWh] = Σ 수소 / Σ AC 발전량 × 1000 */
export function fcKgPerMwh(episodes: readonly FcSteadyEpisode[]): KpiValue {
  const usable = episodes.filter((e) => e.valid && e.features.h2_kg !== null && e.features.ac_kwh !== null && e.features.ac_kwh > 0);
  const h2 = usable.reduce((sum, e) => sum + (e.features.h2_kg ?? 0), 0);
  const ac = usable.reduce((sum, e) => sum + (e.features.ac_kwh ?? 0), 0);
  return kpi(KPI_KEYS.fc_kg_per_mwh, ac > 0 ? (h2 / ac) * 1000 : null, 'kg/MWh', usable.length, meanCompleteness(usable));
}

/** 연료전지 기준 전류밀도 환산 셀 전압 [V] = v_cell_at_jref 중앙값 */
export function fcVCellRef(episodes: readonly FcSteadyEpisode[]): KpiValue {
  const usable = episodes.filter((e) => e.valid && e.features.v_cell_at_jref !== null);
  const value = usable.length === 0 ? null : median(usable.map((e) => e.features.v_cell_at_jref ?? 0));
  return kpi(KPI_KEYS.fc_v_cell_ref, value, 'V', usable.length, meanCompleteness(usable));
}

export interface AvailabilityInput {
  readonly periodHours: number;
  readonly downtimeHours: number;
  /** 계획 정지·출력제어처럼 가용률 분모에서 빼는 시간 */
  readonly excludedHours: number;
  readonly dqCompleteness: number | null;
}

/** 가용률 = (기간 − 제외 − 정지) / (기간 − 제외) */
export function availability(input: AvailabilityInput): KpiValue {
  const denominator = input.periodHours - input.excludedHours;
  const value = denominator > 0 ? clamp01((denominator - input.downtimeHours) / denominator) : null;
  return kpi(KPI_KEYS.availability, value, '', 1, input.dqCompleteness);
}

/** 인버터 일 가용률: 낮 시간(운전 + 정지) 중 운전 비율 */
export function pvDayAvailability(day: PvDayEpisode): KpiValue {
  const { operating_h: operating, stopped_h: stopped } = day.features;
  return availability({ periodHours: operating + stopped, downtimeHours: stopped, excludedHours: 0, dqCompleteness: day.dq.completeness });
}
