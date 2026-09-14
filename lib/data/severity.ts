// 이벤트 심각도 표시. 순수 모듈 (서버·클라이언트 공용). zod가 클라이언트 번들에 들어가지 않게 타입만 가져온다.
import type { EventSeverity } from '@/lib/ingest/envelope';

export type { EventSeverity };

export const SEVERITY_LABELS: Readonly<Record<EventSeverity, string>> = {
  info: '정보',
  minor: '경미',
  major: '주요',
  critical: '심각',
};

/** DB 문자열 → 심각도. CHECK 제약 밖의 값은 들어올 수 없지만 타입을 좁히기 위해 info로 둔다 */
export function toSeverity(value: string): EventSeverity {
  return Object.hasOwn(SEVERITY_LABELS, value) ? (value as EventSeverity) : 'info';
}
