// 원인 판별 체크(checks jsonb) → 표시 모델. 순수 모듈. 모든 탐지기 근거 파서가 같이 쓴다.
import type { CheckStatus } from '@/lib/analytics/detectors/types';
import type { CheckView, MeasuredValue } from './evidence-types';
import { asArray, asRecord, asString } from './json-read';
import { measuredLabel } from './measured-labels';

const CHECK_STATUSES: readonly CheckStatus[] = ['supports', 'refutes', 'unknown', 'no_data'];
const LIST_PREVIEW = 3;

const isPrimitive = (value: unknown): value is number | string | boolean => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';

/** 배열 측정값: 값 목록은 쉼표로, 객체 목록은 앞 몇 건의 값을 이어 쓴다 (예: 필터 교체일·회복 폭) */
function listText(items: readonly unknown[]): string | null {
  if (items.length === 0) return null;
  const parts = items.slice(0, LIST_PREVIEW).map((item) => (isPrimitive(item) ? String(item) : Object.values(asRecord(item)).filter(isPrimitive).join(' ')));
  return `${parts.join(', ')}${items.length > LIST_PREVIEW ? ` 외 ${items.length - LIST_PREVIEW}건` : ''}`;
}

export const measuredValue = (value: unknown): MeasuredValue => (isPrimitive(value) ? value : Array.isArray(value) ? listText(value) : null);

export function parseChecks(value: unknown): CheckView[] {
  return asArray(value).flatMap((item) => {
    const c = asRecord(item);
    const status = asString(c.status);
    const id = asString(c.id);
    if (id === null || status === null || !(CHECK_STATUSES as readonly string[]).includes(status)) return [];
    const measured = Object.entries(asRecord(c.measured)).map(([key, v]) => [measuredLabel(key), measuredValue(v)] as const);
    return [{ id, label: asString(c.label) ?? id, status: status as CheckStatus, measured, note: asString(c.note) ?? '' }];
  });
}
