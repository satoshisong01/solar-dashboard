// SOH 도달일 같은 추세 외삽 표시 가드 (순수, 분석 데스크·리포트 공용).
// 날짜를 쓰는 조건: 데이터 기간 ≥ 최소 기간(ess.capacity_fade minSpanDaysForProjection, 기본 60일)
//                  이고 기울기 95% CI 상한 < 0 (감소가 유의)이며 예상 시점이 기준 시각에서 10년 이내.
// 아니면 날짜 대신 "추세 확인 중(데이터 N일)"으로만 쓴다 — 짧은 기간·유의하지 않은 기울기의 외삽은 수십 년 뒤나 엉뚱한 날짜가 된다.
import { ESS_CAPACITY_DEFAULTS } from '@/lib/analytics/detectors/ess-capacity-fade';
import { MS_PER_DAY } from '@/lib/analytics/types';

export const MAX_PROJECTION_YEARS = 10;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

export interface ProjectionInput {
  /** 외삽 예상 시각 (없으면 null) */
  readonly estimate: number | null;
  readonly early: number | null;
  readonly late: number | null;
  /** 기울기 95% CI 상한 (단위 무관, 부호만 본다) */
  readonly slopeCiHigh: number | null;
  /** 추세 점의 첫·마지막 시각 */
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  /** 근거에 적힌 최소 데이터 기간 [일] (예전 스냅샷은 없음 → 탐지기 기본값) */
  readonly minSpanDays: number | null;
}

export type ProjectionView =
  | { readonly kind: 'date'; readonly estimate: number; readonly early: number | null; readonly late: number | null; readonly spanDays: number }
  | { readonly kind: 'pending'; readonly spanDays: number };

export function projectionOf(input: ProjectionInput): ProjectionView | null {
  if (input.firstTs === null || input.lastTs === null) return null;
  const spanDays = Math.floor((input.lastTs - input.firstTs) / MS_PER_DAY);
  const minSpanDays = input.minSpanDays ?? ESS_CAPACITY_DEFAULTS.minSpanDaysForProjection;
  const { estimate } = input;
  const withinHorizon = estimate !== null && estimate >= input.lastTs && estimate - input.lastTs <= MAX_PROJECTION_YEARS * MS_PER_YEAR;
  if (spanDays >= minSpanDays && input.slopeCiHigh !== null && input.slopeCiHigh < 0 && withinHorizon) return { kind: 'date', estimate, early: input.early, late: input.late, spanDays };
  return { kind: 'pending', spanDays };
}

/** '추세 확인 중(데이터 45일)' */
export const pendingProjectionText = (spanDays: number): string => `추세 확인 중(데이터 ${spanDays}일)`;
