// 팩 수치 반올림·요약 시계열 줄이기 (순수, 팩 조립 모듈 공용).
import { MAX_EVIDENCE_POINTS } from './pack-types';

/** 부동소수 잡음 없이 반올림 (팩 해시가 입력의 계산 경로에 흔들리지 않게) */
export const roundTo = (value: number | null, digits: number): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 앞·뒤 점을 남기고 고르게 max개 이하로 줄인다 */
export function downsamplePoints<T>(points: readonly T[], max = MAX_EVIDENCE_POINTS): T[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as T);
}
