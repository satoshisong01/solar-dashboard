// 메트릭 정의 추가·수정 (설계 §5.2: 메트릭 추가 = INSERT, 스키마 변경 없음).
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인은 Server Action이 한다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { MetricDefInput } from '@/lib/forms/metric-def';
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from './pg-errors';

export type SaveMetricDefResult = 'saved' | 'duplicate_key' | 'not_found' | 'invalid';

/** key를 뺀 저장 열. aliases는 jsonb라 문자열로 보낸다 (pg는 JS 배열을 PG 배열 리터럴로 보낸다) */
function columnsOf(input: MetricDefInput) {
  return {
    name_ko: input.nameKo,
    quantity: input.quantity,
    unit: input.unit,
    value_kind: input.valueKind,
    rollup: input.rollup,
    hard_min: input.hardMin,
    hard_max: input.hardMax,
    expected_min: input.expectedMin,
    expected_max: input.expectedMax,
    flatline_max_s: input.flatlineMaxS,
    aliases: JSON.stringify(input.aliases),
  };
}

function toResult(error: unknown): SaveMetricDefResult {
  const code = pgErrorCode(error);
  if (code === PG_UNIQUE_VIOLATION) return 'duplicate_key';
  if (code === PG_CHECK_VIOLATION) return 'invalid';
  throw error;
}

export async function createMetricDef(db: Kysely<DB>, input: MetricDefInput): Promise<SaveMetricDefResult> {
  try {
    await db.insertInto('om.metric_def').values({ key: input.key, ...columnsOf(input) }).execute();
    return 'saved';
  } catch (error) {
    return toResult(error);
  }
}

/** 키는 포인트가 참조하므로 바꾸지 않는다. input.key와 같은 행을 고친다 */
export async function updateMetricDef(db: Kysely<DB>, input: MetricDefInput): Promise<SaveMetricDefResult> {
  try {
    const result = await db.updateTable('om.metric_def').set(columnsOf(input)).where('key', '=', input.key).executeTakeFirst();
    return result.numUpdatedRows > BigInt(0) ? 'saved' : 'not_found';
  } catch (error) {
    return toResult(error);
  }
}
