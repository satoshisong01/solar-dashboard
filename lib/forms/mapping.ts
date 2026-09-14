// 미매핑 태그 → 포인트 매핑 폼 검증 (설계 §5.2 point). 서버 전용 (zod).
// DB 쪽 확인(인박스에 있는 태그인지, 설비가 게이트웨이 사이트 소속인지, 중복)은 lib/ops/mapping.ts가 한다.
import * as z from 'zod';
import { fieldErrorsOf, type FieldErrors, type FormValues } from './action-state';
import { decimalFieldWithDefault, idField, optionalIntField, pickFields, SMALLINT_MAX } from './fields';

/** om.metric_def.key CHECK와 같은 규칙에 "도메인.물리량" 두 마디 이상 (lib/forms/metric-def.ts와 공유) */
export const METRIC_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
/** 같은 설비에 같은 메트릭이 여럿일 때 구분자 (예: product, loop, inlet). 비워 두면 구분 없음 */
export const QUALIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SOURCE_KEY_MAX = 200; // lib/ingest/envelope.ts의 태그 길이 상한
const PERIOD_MAX_S = 86_400;

const MAPPING_KEYS = ['gatewayId', 'sourceKey', 'assetId', 'metricKey', 'qualifier', 'scale', 'valueOffset', 'periodS'] as const;

const mappingSchema = z.object({
  gatewayId: idField('게이트웨이가 올바르지 않습니다', SMALLINT_MAX),
  sourceKey: z.string().min(1, '원본 태그가 없습니다').max(SOURCE_KEY_MAX, `원본 태그는 ${SOURCE_KEY_MAX}자 이하입니다`),
  assetId: idField('설비를 고르세요'),
  metricKey: z.string().trim().regex(METRIC_KEY_PATTERN, '메트릭을 고르세요'),
  qualifier: z
    .string()
    .trim()
    .refine((value) => value === '' || QUALIFIER_PATTERN.test(value), '구분자는 영문 소문자로 시작하는 소문자·숫자·_·- 32자 이하입니다'),
  scale: decimalFieldWithDefault('배율', 1).refine((value) => value !== 0, '배율은 0일 수 없습니다'),
  valueOffset: decimalFieldWithDefault('오프셋', 0),
  periodS: optionalIntField('수집 주기', 1, PERIOD_MAX_S),
});

export type MappingInput = z.output<typeof mappingSchema>;

export type MappingParseResult =
  | Readonly<{ ok: true; input: MappingInput }>
  | Readonly<{ ok: false; fieldErrors: FieldErrors }>;

/** 정규값 = 원본값 × scale + valueOffset. periodS는 빈 값이면 null */
export function parseMappingForm(values: FormValues): MappingParseResult {
  const result = mappingSchema.safeParse(pickFields(values, MAPPING_KEYS));
  return result.success ? { ok: true, input: result.data } : { ok: false, fieldErrors: fieldErrorsOf(result.error) };
}
