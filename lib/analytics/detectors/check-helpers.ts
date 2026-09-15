// P3 탐지기 판별 체크 공용 도우미 (순수): 체크 생성, 변화량 → 지지/반박/불명/데이터없음, 중앙값·상관계수.
import { median } from '../stats/robust';
import type { JsonObject } from '../types';
import type { CheckStatus, DiagnosticCheck } from './types';

/** 안전 관련 권고에 붙이는 고정 원칙 문구 (설계 §9 안전 레인 분리) */
export const SAFETY_DISCLAIMER = '이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.';

export const makeCheck = (id: string, label: string, status: CheckStatus, measured: JsonObject, note: string): DiagnosticCheck => ({ id, label, status, measured, note });

export const medianOrNull = (values: readonly number[]): number | null => (values.length === 0 ? null : median(values));

/** 값 ≥ supportAt → 지지, 값 ≤ refuteAt → 반박, 그 사이 → 불명, null → 데이터없음 */
export function levelStatus(value: number | null, supportAt: number, refuteAt: number): CheckStatus {
  if (value === null || !Number.isFinite(value)) return 'no_data';
  if (value >= supportAt) return 'supports';
  return value <= refuteAt ? 'refutes' : 'unknown';
}

export type CheckNotes = Readonly<Record<CheckStatus, string>>;

/** 수준 값 하나로 판정하는 체크: levelStatus + 상태별 문구 */
export function levelCheck(id: string, label: string, value: number | null, thresholds: readonly [supportAt: number, refuteAt: number], measured: JsonObject, notes: CheckNotes): DiagnosticCheck {
  const status = levelStatus(value, thresholds[0], thresholds[1]);
  return makeCheck(id, label, status, measured, notes[status]);
}

/** 피어슨 상관계수. 짝이 3개 미만이거나 한쪽 분산이 0이면 null */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 기준·최근 값 중앙값과 차이 (한쪽이 비면 null) */
export function medianShift(reference: readonly number[], recent: readonly number[]): { readonly ref: number; readonly cur: number; readonly shift: number } | null {
  const ref = medianOrNull(reference);
  const cur = medianOrNull(recent);
  return ref === null || cur === null ? null : { ref, cur, shift: cur - ref };
}

/** 기준 대비 최근 중앙값 변화율 [%] (기준 중앙값이 0 이하이면 null) */
export function medianChangePct(reference: readonly number[], recent: readonly number[]): number | null {
  const shift = medianShift(reference, recent);
  return shift === null || !(shift.ref > 0) ? null : (shift.cur / shift.ref - 1) * 100;
}
