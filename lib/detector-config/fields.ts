// 탐지기 paramSchema(zod) → 설정 폼 필드 (순수, 서버 전용: zod를 클라이언트 번들에 넣지 않는다).
// z.toJSONSchema 결과의 필드 속성(meta label·unit·description, default, type/anyOf[null], minimum·maximum, enum)을 읽는다.
// 모르는 모양(객체·배열 등)의 필드는 폼에서 다룰 수 없으므로 뺀다 (현재 레지스트리 14종에는 없다).
import * as z from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';
import { asArray, asNumber, asRecord, asString, type JsonRecord } from '@/lib/desk/json-read';
import type { ParamField, ParamFieldKind, ParamValue } from './types';

function kindOf(schema: JsonRecord): ParamFieldKind | null {
  if (schema.type === 'integer') return 'integer';
  if (schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'string' && Array.isArray(schema.enum)) return 'choice';
  return null;
}

const defaultOf = (value: unknown): ParamValue => (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || value === null ? value : null);

function fieldOf(key: string, raw: unknown): ParamField | null {
  const property = asRecord(raw);
  const variants = asArray(property.anyOf).map(asRecord);
  const nullable = variants.some((v) => v.type === 'null');
  const body = nullable ? (variants.find((v) => v.type !== 'null') ?? {}) : property;
  const kind = kindOf(body);
  if (kind === null) return null;
  return {
    key,
    kind,
    nullable,
    label: asString(property.label) ?? key,
    unit: asString(property.unit) ?? '',
    description: asString(property.description) ?? '',
    min: asNumber(body.minimum),
    max: asNumber(body.maximum),
    options: asArray(body.enum).flatMap((v) => (typeof v === 'string' ? [v] : [])),
    defaultValue: defaultOf(property.default),
  };
}

/** 스키마 선언 순서대로 폼 필드 */
export function paramFields(schema: ZodObject<ZodRawShape>): ParamField[] {
  const json = asRecord(z.toJSONSchema(schema));
  return Object.entries(asRecord(json.properties)).flatMap(([key, raw]) => {
    const field = fieldOf(key, raw);
    return field ? [field] : [];
  });
}
