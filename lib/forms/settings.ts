// 게이트웨이·관리자·시장가격 수기 입력·안전 이벤트 확인 폼 검증. 서버 전용 (zod).
import * as z from 'zod';
import { KEY_ID_PATTERN } from '@/lib/ingest/signature';
import { dayError, MARKET_KEYS, parseMarketValue, type MarketRow } from '@/lib/market/keys';
import { fieldErrorsOf, type FieldErrors, type FormValues } from './action-state';
import { idField, pickFields, SMALLINT_MAX } from './fields';
import { ACK_NOTE_MAX, PASSWORD_MAX, PASSWORD_MIN } from './limits';

export type ParseResult<T> = Readonly<{ ok: true; input: T }> | Readonly<{ ok: false; fieldErrors: FieldErrors }>;

function parseWith<T>(schema: z.ZodType<T>, values: Readonly<Record<string, string>>): ParseResult<T> {
  const result = schema.safeParse(values);
  return result.success ? { ok: true, input: result.data } : { ok: false, fieldErrors: fieldErrorsOf(result.error) };
}

/** 대문자·숫자·하이픈 2~64자, 영숫자로 시작 (예: GW-SIMB-01). 입력은 대문자로 바꿔 받는다 */
export const GATEWAY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,63}$/;

const gatewaySchema = z.object({
  siteId: idField('사이트를 고르세요', SMALLINT_MAX),
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(GATEWAY_CODE_PATTERN, '게이트웨이 코드는 영문 대문자·숫자·하이픈 2~64자입니다 (예: GW-SIMB-02)')),
});

export function parseGatewayForm(values: FormValues): ParseResult<z.output<typeof gatewaySchema>> {
  return parseWith(gatewaySchema, pickFields(values, ['siteId', 'code']));
}

const gatewayIdSchema = z.object({ gatewayId: idField('게이트웨이가 올바르지 않습니다', SMALLINT_MAX) });

/** 재처리·키 발급 버튼의 hidden gatewayId */
export function parseGatewayIdForm(values: FormValues): ParseResult<z.output<typeof gatewayIdSchema>> {
  return parseWith(gatewayIdSchema, pickFields(values, ['gatewayId']));
}

const keyIdSchema = z.object({ keyId: z.string().regex(KEY_ID_PATTERN, '키 ID가 올바르지 않습니다') });

export function parseKeyIdForm(values: FormValues): ParseResult<z.output<typeof keyIdSchema>> {
  return parseWith(keyIdSchema, pickFields(values, ['keyId']));
}

const adminSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('올바른 이메일이 아닙니다').max(254, '이메일이 너무 깁니다')),
  name: z.string().trim().min(1, '이름을 입력하세요').max(60, '이름은 60자 이하입니다'),
  password: z
    .string()
    .min(PASSWORD_MIN, `임시 비밀번호는 ${PASSWORD_MIN}자 이상입니다`)
    .max(PASSWORD_MAX, `임시 비밀번호는 ${PASSWORD_MAX}자 이하입니다`),
});

export function parseAdminForm(values: FormValues): ParseResult<z.output<typeof adminSchema>> {
  return parseWith(adminSchema, pickFields(values, ['email', 'name', 'password']));
}

const userIdSchema = z.object({ userId: z.string().trim().min(1, '사용자가 없습니다').max(128, '사용자 ID가 올바르지 않습니다') });

export function parseUserIdForm(values: FormValues): ParseResult<z.output<typeof userIdSchema>> {
  return parseWith(userIdSchema, pickFields(values, ['userId']));
}

const ackSchema = z.object({
  eventId: z.string().regex(/^[1-9]\d{0,17}$/, '이벤트가 올바르지 않습니다'), // bigint 범위 안 (18자리까지)
  note: z.string().trim().min(1, '확인 메모를 입력하세요').max(ACK_NOTE_MAX, `메모는 ${ACK_NOTE_MAX}자 이하입니다`),
});

export function parseAckForm(values: FormValues): ParseResult<z.output<typeof ackSchema>> {
  return parseWith(ackSchema, pickFields(values, ['eventId', 'note']));
}

/** 수기 입력: 날짜 하나에 항목별 값(빈 칸은 건너뜀). 한 항목 이상 필요 */
export function parseMarketManualForm(values: FormValues): ParseResult<readonly MarketRow[]> {
  const fieldErrors: Record<string, string> = {};
  const day = (values.day ?? '').trim();
  const problem = dayError(day);
  if (problem) fieldErrors.day = problem;

  const rows = MARKET_KEYS.flatMap((marketKey): MarketRow[] => {
    const raw = (values[marketKey] ?? '').trim();
    if (raw === '') return [];
    const parsed = parseMarketValue(raw);
    if ('error' in parsed) {
      fieldErrors[marketKey] = parsed.error;
      return [];
    }
    return [{ day, marketKey, value: parsed.value }];
  });
  if (rows.length === 0 && Object.keys(fieldErrors).every((key) => key === 'day')) fieldErrors[''] = '값을 한 항목 이상 입력하세요';

  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, input: rows };
}
