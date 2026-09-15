// 탐지기 설정 화면 공용 타입과 표시 도우미. 순수 모듈 (zod 없음 — 클라이언트 폼도 가져온다).

export type ParamFieldKind = 'number' | 'integer' | 'boolean' | 'choice';
export type ParamValue = number | boolean | string | null;

/** paramSchema 필드 하나 → 폼 입력 하나 */
export interface ParamField {
  readonly key: string;
  readonly kind: ParamFieldKind;
  /** null(자동·명판값)을 명시해 저장할 수 있는 필드 */
  readonly nullable: boolean;
  readonly label: string;
  readonly unit: string;
  readonly description: string;
  readonly min: number | null;
  readonly max: number | null;
  /** choice 선택지 */
  readonly options: readonly string[];
  /** 코드 기본값 */
  readonly defaultValue: ParamValue;
}

export type ScopeKind = 'default' | 'class' | 'asset';

/** 폼 필드 이름 규칙 (서버 파서와 클라이언트 폼이 함께 쓴다) */
export const paramInputName = (key: string): string => `param.${key}`;
export const paramNullName = (key: string): string => `param.${key}.null`;

/** 설정 범위 문자열 → 표시 이름. 설비 범위 이름은 호출하는 쪽이 넘긴다 */
export function scopeLabel(scope: string, assetName?: string | null): string {
  if (scope === 'default') return '기본 (default)';
  if (scope.startsWith('class:')) return `설비 종류 ${scope.slice('class:'.length)}`;
  if (scope.startsWith('asset:')) return `설비 ${assetName ?? `#${scope.slice('asset:'.length)}`}`;
  return scope;
}

export function scopeKindOf(scope: string): ScopeKind | null {
  if (scope === 'default') return 'default';
  if (scope.startsWith('class:')) return 'class';
  if (scope.startsWith('asset:')) return 'asset';
  return null;
}

/** 값 표시: 불리언 켜기/끄기, null은 '자동(비움)' */
export function formatParamValue(value: unknown): string {
  if (value === null) return '자동(비움)';
  if (typeof value === 'boolean') return value ? '켜기' : '끄기';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value) ?? '—';
}
