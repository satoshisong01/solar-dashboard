// 게이트 판정 한 줄 (순수).
import { r } from '@/lib/analytics/detectors/common';

export interface GateResult {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly comparator: '>=' | '<=' | '<';
  readonly threshold: number;
  /** 평가할 주입이 없으면(value null) 실패로 본다 */
  readonly pass: boolean;
}

const compare = (value: number, comparator: GateResult['comparator'], threshold: number): boolean => (comparator === '>=' ? value >= threshold : comparator === '<=' ? value <= threshold : value < threshold);

export const gate = (id: string, description: string, value: number | null, comparator: GateResult['comparator'], threshold: number): GateResult => ({
  id,
  description,
  value: value === null ? null : (r(value, 4) ?? null),
  comparator,
  threshold,
  pass: value !== null && compare(value, comparator, threshold),
});
