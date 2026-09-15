// 탐지기 설정 새 버전 폼 검증 (순수, 서버 전용). 폼 문자열 → 범위·파라미터·기준 창.
//   범위    scopeKind(default | class | asset) 중 이 탐지기 실행에 실제로 적용되는 것만 (pipeline/targets.ts), asset이면 assetId
//   파라미터 입력이 빈 필드는 저장하지 않는다(더 넓은 범위·코드 기본값을 물려받음). 숫자는 10진수(지수 표기 불가)·정수 여부·min~max,
//           불리언은 'true' | 'false', 선택지는 목록 안, null 가능 필드는 '자동(비움)' 체크로 null을 저장한다.
//           마지막에 탐지기 paramSchema로 한 번 더 검증한다 (필드 변환과 스키마가 어긋나도 잘못된 값이 저장되지 않게).
//   기준 창 시작·끝 날짜(KST, 양 끝 포함)를 둘 다 비우면 없음. [시작 0시, 끝 다음 날 0시) tstzrange로 저장한다.
import type { ZodObject, ZodRawShape } from 'zod';
import { allowedScopeKinds, type DetectorTargeting } from '@/lib/analytics/pipeline/targets';
import type { FieldErrors, FormValues } from '@/lib/forms/action-state';
import { paramInputName, paramNullName, type ParamField, type ParamValue, type ScopeKind } from './types';

export type ParseResult<T> = Readonly<{ ok: true; input: T }> | Readonly<{ ok: false; fieldErrors: FieldErrors }>;

export interface ReferenceWindowInput {
  readonly startDay: string;
  readonly endDay: string;
  /** [startMs, endMs) */
  readonly startMs: number;
  readonly endMs: number;
}

export interface DetectorConfigInput {
  readonly scopeKind: ScopeKind;
  readonly scope: string;
  readonly assetId: number | null;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly referenceWindow: ReferenceWindowInput | null;
}

const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;
const POSITIVE_INT = /^[1-9]\d{0,9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const ASSET_ID_MAX = 2_147_483_647;

type FieldResult = { readonly set: false } | { readonly set: true; readonly value: ParamValue } | { readonly error: string };

function parseField(field: ParamField, values: FormValues): FieldResult {
  const raw = (values[paramInputName(field.key)] ?? '').trim();
  const wantsNull = values[paramNullName(field.key)] === 'on';
  if (wantsNull) {
    if (!field.nullable) return { error: '이 파라미터는 비워 둘 수 없습니다' };
    return raw === '' ? { set: true, value: null } : { error: '자동(비움)을 고르면 값을 비워 두세요' };
  }
  if (raw === '') return { set: false };
  switch (field.kind) {
    case 'boolean':
      return raw === 'true' || raw === 'false' ? { set: true, value: raw === 'true' } : { error: '켜기 또는 끄기를 고르세요' };
    case 'choice':
      return field.options.includes(raw) ? { set: true, value: raw } : { error: '목록에 있는 값을 고르세요' };
    case 'number':
    case 'integer': {
      const value = Number(raw);
      if (!DECIMAL.test(raw) || !Number.isFinite(value)) return { error: '숫자를 입력하세요 (지수 표기 불가)' };
      if (field.kind === 'integer' && !Number.isInteger(value)) return { error: '정수를 입력하세요' };
      const unit = field.unit === '' ? '' : ` ${field.unit}`;
      if ((field.min !== null && value < field.min) || (field.max !== null && value > field.max)) return { error: `${field.min ?? '−∞'}~${field.max ?? '∞'}${unit} 사이여야 합니다` };
      return { set: true, value };
    }
  }
}

function parseScope(values: FormValues, targeting: DetectorTargeting): ParseResult<Pick<DetectorConfigInput, 'scopeKind' | 'scope' | 'assetId'>> {
  const kind = values.scopeKind ?? '';
  const allowed: readonly string[] = allowedScopeKinds(targeting);
  if (!allowed.includes(kind)) return { ok: false, fieldErrors: { scopeKind: '이 탐지기 실행에 적용되는 범위를 고르세요' } };
  if (kind === 'default') return { ok: true, input: { scopeKind: 'default', scope: 'default', assetId: null } };
  if (kind === 'class') return { ok: true, input: { scopeKind: 'class', scope: `class:${targeting.configClass}`, assetId: null } };
  const raw = (values.assetId ?? '').trim();
  if (!POSITIVE_INT.test(raw) || Number(raw) > ASSET_ID_MAX) return { ok: false, fieldErrors: { assetId: '설비를 목록에서 고르세요' } };
  return { ok: true, input: { scopeKind: 'asset', scope: `asset:${Number(raw)}`, assetId: Number(raw) } };
}

const kstDayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`) - KST_OFFSET_MS;
const isCalendarDay = (day: string): boolean => DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);

function parseReferenceWindow(values: FormValues): ParseResult<ReferenceWindowInput | null> {
  const start = (values.refStart ?? '').trim();
  const end = (values.refEnd ?? '').trim();
  if (start === '' && end === '') return { ok: true, input: null };
  const errors: Record<string, string> = {};
  if (!isCalendarDay(start)) errors.refStart = '기준 창 시작일을 입력하세요 (둘 다 비우면 기준 창 없음)';
  if (!isCalendarDay(end)) errors.refEnd = '기준 창 끝일을 입력하세요 (둘 다 비우면 기준 창 없음)';
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  if (end < start) return { ok: false, fieldErrors: { refEnd: '끝일은 시작일과 같거나 늦어야 합니다' } };
  return { ok: true, input: { startDay: start, endDay: end, startMs: kstDayStartMs(start), endMs: kstDayStartMs(end) + DAY_MS } };
}

interface ParseInput {
  readonly values: FormValues;
  readonly fields: readonly ParamField[];
  /** 탐지기 paramSchema (ParamSchema<P>는 모두 ZodObject다) */
  readonly schema: ZodObject<ZodRawShape>;
  readonly defaultParams: object;
  readonly targeting: DetectorTargeting;
}

export function parseDetectorConfigForm({ values, fields, schema, defaultParams, targeting }: ParseInput): ParseResult<DetectorConfigInput> {
  const scope = parseScope(values, targeting);
  const window = parseReferenceWindow(values);
  const parsedFields = fields.map((field) => ({ field, result: parseField(field, values) }));
  const fieldErrors: Record<string, string> = {
    ...(scope.ok ? {} : scope.fieldErrors),
    ...(window.ok ? {} : window.fieldErrors),
    ...Object.fromEntries(parsedFields.flatMap(({ field, result }) => ('error' in result ? [[paramInputName(field.key), `${field.label}: ${result.error}`]] : []))),
  };
  if (!scope.ok || !window.ok || Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const params = Object.fromEntries(parsedFields.flatMap(({ field, result }) => ('set' in result && result.set ? [[field.key, result.value]] : [])));
  // 스키마 재검증: 저장할 값만(부분)과, 코드 기본값에 얹은 전체를 모두 확인한다
  const partial = schema.partial().safeParse(params);
  const merged = schema.safeParse({ ...defaultParams, ...params });
  const issues = [...(partial.success ? [] : partial.error.issues), ...(merged.success ? [] : merged.error.issues)];
  if (issues.length > 0) {
    return { ok: false, fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path.length > 0 ? paramInputName(issue.path.map(String).join('.')) : '', `스키마 검증 실패: ${issue.message}`])) };
  }
  return { ok: true, input: { ...scope.input, params, referenceWindow: window.input } };
}
