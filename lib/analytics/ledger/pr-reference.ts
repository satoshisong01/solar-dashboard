// 기준 성능비 PR_ref 추정 (순수): 기준 기간 맑은 날의 온도보정 PR 중앙값.
//   날마다 깨끗한 시간(일사 있음 · 정지/트립 아님 · 출력 제한 없음 · 클리핑 아님 · 출력 데이터 있음)만 모아
//   PR_day = Σ 실제 AC / Σ (POA/1000 × kWp × 온도계수).
//   맑은 날 = 그날 경사면 일사량(kWh/m²)이 기준 기간 일사량 분포의 clearDayQuantile 분위 이상인 날.
//   맑은 날이 minClearDays 미만이면 추정하지 않는다(null) — 그때는 params로 PR_ref를 넣는다.
import { median, quantile } from '../stats/robust';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { createLedgerContext, round } from './hourly';
import { resolveLedgerParams, type LedgerParams } from './params';
import { hourWeather, inverterHours } from './pv-loss';
import type { LedgerAsset, LedgerHourRow, PrReference } from './types';

export interface PrReferenceInput {
  readonly assets: readonly LedgerAsset[];
  /** 기준 기간 m_1h 행 */
  readonly rows: readonly LedgerHourRow[];
  /** 기준 기간 KST 0시 목록 */
  readonly dayStarts: readonly number[];
  readonly params?: Partial<LedgerParams>;
}

export interface PrReferenceEstimate {
  readonly reference: PrReference | null;
  readonly clearDays: number;
  readonly candidateDays: number;
}

interface DaySample {
  readonly insolation: number;
  readonly pr: number;
}

function daySample(input: PrReferenceInput, params: LedgerParams, dayStart: number): DaySample | null {
  const rows = input.rows.filter((r) => r.hourStart >= dayStart - MS_PER_HOUR && r.hourStart < dayStart + MS_PER_DAY);
  const ctx = createLedgerContext(dayStart, input.assets, rows, params.fallbackPeriodS);
  let insolation = 0;
  let actual = 0;
  let reference = 0;
  for (const hourStart of ctx.hours) {
    const weather = hourWeather(ctx, params, hourStart);
    if (weather.poa === null) continue;
    insolation += weather.poa / 1000;
    if (weather.poa < params.sunIrradiance) continue;
    const clean = inverterHours(ctx, params, weather, hourStart).hours.filter((h) => !h.outage && !h.limited && h.maxKw < params.clippingFraction * h.ratedKw);
    actual += clean.reduce((sum, h) => sum + h.actual, 0);
    reference += clean.reduce((sum, h) => sum + h.reference, 0);
  }
  return reference > 0 ? { insolation, pr: actual / reference } : null;
}

export function estimateReferencePr(input: PrReferenceInput): PrReferenceEstimate {
  const params = resolveLedgerParams(input.params);
  const samples = input.dayStarts.map((day) => daySample(input, params, day)).filter((s): s is DaySample => s !== null);
  if (samples.length === 0) return { reference: null, clearDays: 0, candidateDays: 0 };
  const threshold = quantile(samples.map((s) => s.insolation), params.clearDayQuantile);
  const clear = samples.filter((s) => s.insolation >= threshold);
  return {
    reference: clear.length >= params.minClearDays ? { value: round(median(clear.map((s) => s.pr)), 4), method: 'reference_clear_days' } : null,
    clearDays: clear.length,
    candidateDays: samples.length,
  };
}
