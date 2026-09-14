// 폼 검증 스키마(서버)와 입력 요소 속성(클라이언트)이 함께 쓰는 값. 순수 모듈 (zod 없음).

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const ACK_NOTE_MAX = 500;

export const VALUE_KINDS = ['gauge', 'counter', 'state', 'bool'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const VALUE_KIND_LABELS: Readonly<Record<ValueKind, string>> = {
  gauge: '순시값 (gauge)',
  counter: '누적 카운터 (counter)',
  state: '상태 코드 (state)',
  bool: '참/거짓 (bool)',
};

export const ROLLUP_KINDS = ['avg', 'sum', 'last', 'max', 'min', 'delta'] as const;
export type RollupKind = (typeof ROLLUP_KINDS)[number];

export const ROLLUP_LABELS: Readonly<Record<RollupKind, string>> = {
  avg: '평균 (avg)',
  sum: '합계 (sum)',
  last: '마지막 값 (last)',
  max: '최댓값 (max)',
  min: '최솟값 (min)',
  delta: '증가량 (delta)',
};

export function labelOf<K extends string>(labels: Readonly<Record<K, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value as K] : value;
}
