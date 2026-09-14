// 메트릭 정의(om.metric_def) 추가·수정 폼 검증. 서버 전용 (zod). DB CHECK 제약과 같은 규칙을 먼저 확인해 한국어로 알린다.
import * as z from 'zod';
import { fieldErrorsOf, type FieldErrors, type FormValues } from './action-state';
import { optionalDecimalField, optionalIntField, pickFields } from './fields';
import { ROLLUP_KINDS, VALUE_KINDS } from './limits';
import { METRIC_KEY_PATTERN } from './mapping';

const KEY_MAX = 64;
const QUANTITY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const FLATLINE_MAX_S = 30 * 86_400;
const ALIAS_MAX = 20;
const ALIAS_LENGTH_MAX = 80;

const METRIC_KEYS = [
  'key',
  'nameKo',
  'quantity',
  'unit',
  'valueKind',
  'rollup',
  'hardMin',
  'hardMax',
  'expectedMin',
  'expectedMax',
  'flatlineMaxS',
  'aliases',
] as const;

/** 줄바꿈·쉼표로 나눈 별칭. 앞뒤 공백 제거, 빈 항목·중복 제거 (입력 순서 유지) */
export function splitAliases(raw: string): readonly string[] {
  const items = raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return [...new Set(items)];
}

const metricSchema = z
  .object({
    key: z
      .string()
      .trim()
      .max(KEY_MAX, `키는 ${KEY_MAX}자 이하입니다`)
      .regex(METRIC_KEY_PATTERN, '키는 "도메인.물리량[.구분]" 형식의 영문 소문자·숫자입니다 (예: stack.temp.in)'),
    nameKo: z.string().trim().min(1, '이름을 입력하세요').max(60, '이름은 60자 이하입니다'),
    quantity: z.string().trim().regex(QUANTITY_PATTERN, '물리량은 영문 소문자로 시작하는 소문자·숫자·_ 40자 이하입니다 (예: temperature)'),
    unit: z.string().trim().max(20, '단위는 20자 이하입니다'),
    valueKind: z.enum(VALUE_KINDS, { error: '값 종류를 고르세요' }),
    rollup: z.enum(ROLLUP_KINDS, { error: '롤업 방식을 고르세요' }),
    hardMin: optionalDecimalField('물리 하한'),
    hardMax: optionalDecimalField('물리 상한'),
    expectedMin: optionalDecimalField('정상 하한'),
    expectedMax: optionalDecimalField('정상 상한'),
    flatlineMaxS: optionalIntField('고착 판정 시간', 1, FLATLINE_MAX_S),
    aliases: z
      .string()
      .transform(splitAliases)
      .refine((items) => items.length <= ALIAS_MAX, `별칭은 ${ALIAS_MAX}개까지입니다`)
      .refine((items) => items.every((item) => item.length <= ALIAS_LENGTH_MAX), `별칭 하나는 ${ALIAS_LENGTH_MAX}자 이하입니다`),
  })
  .refine((m) => m.hardMin === null || m.hardMax === null || m.hardMin < m.hardMax, {
    path: ['hardMax'],
    error: '물리 상한은 하한보다 커야 합니다',
  })
  .refine((m) => m.expectedMin === null || m.expectedMax === null || m.expectedMin <= m.expectedMax, {
    path: ['expectedMax'],
    error: '정상 상한은 하한보다 작을 수 없습니다',
  });

export type MetricDefInput = z.output<typeof metricSchema>;

export type MetricDefParseResult =
  | Readonly<{ ok: true; input: MetricDefInput }>
  | Readonly<{ ok: false; fieldErrors: FieldErrors }>;

export function parseMetricDefForm(values: FormValues): MetricDefParseResult {
  const result = metricSchema.safeParse(pickFields(values, METRIC_KEYS));
  return result.success ? { ok: true, input: result.data } : { ok: false, fieldErrors: fieldErrorsOf(result.error) };
}
