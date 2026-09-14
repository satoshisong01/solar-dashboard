// 폼 문자열 필드용 zod 스키마 조각. 서버(Server Action) 전용으로 쓴다: zod를 클라이언트 번들에 넣지 않는다.
import * as z from 'zod';

export const INT4_MAX = 2_147_483_647;
/** om.site·om.gateway id (smallint) */
export const SMALLINT_MAX = 32_767;
const DECIMAL_PATTERN = /^-?(\d+(\.\d*)?|\.\d+)$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d{0,9}$/;

/** 1 이상 id (select·hidden 값). 기본 상한은 int4, smallint 열이면 SMALLINT_MAX */
export const idField = (message: string, max: number = INT4_MAX) =>
  z
    .string({ error: message })
    .trim()
    .regex(POSITIVE_INT_PATTERN, message)
    .transform(Number)
    .refine((value) => value <= max, message);

/** 빈 값이면 null, 아니면 유한한 10진수 (지수 표기·천 단위 쉼표 불가) */
export const optionalDecimalField = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === '' || DECIMAL_PATTERN.test(value), `${label}은(는) 숫자여야 합니다`)
    .transform((value) => (value === '' ? null : Number(value)))
    .refine((value) => value === null || Number.isFinite(value), `${label}은(는) 숫자여야 합니다`);

/** 빈 값이면 기본값, 아니면 유한한 10진수 */
export const decimalFieldWithDefault = (label: string, fallback: number) =>
  optionalDecimalField(label).transform((value) => value ?? fallback);

/** 빈 값이면 null, 아니면 min~max 정수 */
export const optionalIntField = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === '' || /^\d{1,10}$/.test(value), `${label}은(는) 정수여야 합니다`)
    .transform((value) => (value === '' ? null : Number(value)))
    .refine((value) => value === null || (value >= min && value <= max), `${label}은(는) ${min}~${max} 사이여야 합니다`);

/** 스키마가 기대하는 키만 골라, 폼에 없던 키(체크하지 않은 입력 등)는 빈 문자열로 채운다 */
export function pickFields<K extends string>(values: Readonly<Record<string, string>>, keys: readonly K[]): Readonly<Record<K, string>> {
  return Object.fromEntries(keys.map((key) => [key, values[key] ?? ''])) as Record<K, string>;
}
