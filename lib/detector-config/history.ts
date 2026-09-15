// 탐지기 설정 이력 표시 (순수): 범위별 활성 버전·버전 이력과 바로 앞 버전 대비 params 차이, 코드 기본값 대비 변경 여부.
import { formatParamValue, scopeKindOf, type ParamField } from './types';

export interface ConfigVersionRow {
  readonly scope: string;
  readonly version: number;
  readonly params: Readonly<Record<string, unknown>>;
  /** 기준 창 KST 날짜 (끝은 포함) */
  readonly referenceWindow: Readonly<{ startDay: string; endDay: string }> | null;
  readonly active: boolean;
  readonly createdBy: string;
  readonly createdAtMs: number;
}

export interface ParamChange {
  readonly key: string;
  readonly label: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly before: string | null;
  readonly after: string | null;
}

export interface VersionView extends ConfigVersionRow {
  /** 같은 범위 바로 앞 버전 대비 (첫 버전은 모든 키가 added) */
  readonly changes: readonly ParamChange[];
  readonly windowChanged: boolean;
}

export interface ScopeHistory {
  readonly scope: string;
  readonly active: ConfigVersionRow | null;
  /** 최신 버전부터 */
  readonly versions: readonly VersionView[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function paramsDiff(before: Readonly<Record<string, unknown>> | null, after: Readonly<Record<string, unknown>>, fields: readonly ParamField[]): ParamChange[] {
  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const order = (key: string) => {
    const index = fields.findIndex((f) => f.key === key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const prev = before ?? {};
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(after)])].sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  return keys.flatMap((key): ParamChange[] => {
    const had = Object.hasOwn(prev, key);
    const has = Object.hasOwn(after, key);
    if (had && has && same(prev[key], after[key])) return [];
    return [{ key, label: labelOf(key), change: !had ? 'added' : !has ? 'removed' : 'changed', before: had ? formatParamValue(prev[key]) : null, after: has ? formatParamValue(after[key]) : null }];
  });
}

const SCOPE_ORDER: Readonly<Record<string, number>> = { default: 0, class: 1, asset: 2 };

function compareScope(a: string, b: string): number {
  const rank = (s: string) => SCOPE_ORDER[scopeKindOf(s) ?? ''] ?? 3;
  const id = (s: string) => Number(s.slice(s.indexOf(':') + 1));
  return rank(a) - rank(b) || (scopeKindOf(a) === 'asset' ? id(a) - id(b) : a < b ? -1 : a > b ? 1 : 0);
}

/** 범위별 이력 (default → class → asset id 순) */
export function configHistory(rows: readonly ConfigVersionRow[], fields: readonly ParamField[]): ScopeHistory[] {
  const scopes = [...new Set(rows.map((r) => r.scope))].sort(compareScope);
  return scopes.map((scope) => {
    const ascending = rows.filter((r) => r.scope === scope).sort((a, b) => a.version - b.version);
    const versions = ascending.map((row, i) => {
      const previous = i === 0 ? null : (ascending[i - 1] as ConfigVersionRow);
      return { ...row, changes: paramsDiff(previous?.params ?? null, row.params, fields), windowChanged: previous !== null && !same(previous.referenceWindow, row.referenceWindow) };
    });
    return { scope, active: ascending.find((r) => r.active) ?? null, versions: [...versions].reverse() };
  });
}

/** 입력값이 코드 기본값과 다른지 (빈 입력은 변경 아님). 숫자는 수치로 비교한다 */
export function differsFromDefault(field: ParamField, raw: string, nullChecked: boolean): boolean {
  if (nullChecked) return field.defaultValue !== null;
  const text = raw.trim();
  if (text === '') return false;
  if (field.kind === 'number' || field.kind === 'integer') return field.defaultValue === null || Number(text) !== field.defaultValue;
  if (field.kind === 'boolean') return String(field.defaultValue) !== text;
  return field.defaultValue !== text;
}

/** 폼에 채울 입력 문자열 (값이 없으면 빈 문자열 = 물려받음) */
export function inputTextOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? String(value) : '';
}
