// SMP·REC 일별 값 저장 (수기 입력·CSV). 같은 (날짜, 항목)은 덮어쓴다.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { MARKET_UNITS, type MarketRow } from '@/lib/market/keys';

export interface UpsertMarketResult {
  readonly inserted: number;
  readonly updated: number;
}

/** 한 문장으로 upsert한다 (전부 들어가거나 전부 실패). 새로 넣은 행과 덮어쓴 행 수를 돌려준다 */
export async function upsertMarketRows(
  db: Kysely<DB>,
  rows: readonly MarketRow[],
  meta: Readonly<{ source: 'manual' | 'csv'; actor: string }>,
): Promise<UpsertMarketResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const { rows: result } = await sql<{ inserted: number; updated: number }>`
    WITH up AS (
      INSERT INTO om.market_daily AS d (day, market_key, value, unit, source, updated_by, updated_at)
      SELECT t.day, t.market_key, t.value, t.unit, ${meta.source}, ${meta.actor}, now()
      FROM unnest(
        ${rows.map((row) => row.day)}::date[],
        ${rows.map((row) => row.marketKey)}::text[],
        ${rows.map((row) => String(row.value))}::numeric[],
        ${rows.map((row) => MARKET_UNITS[row.marketKey])}::text[]
      ) AS t(day, market_key, value, unit)
      ORDER BY t.day, t.market_key
      ON CONFLICT (day, market_key) DO UPDATE SET
        value = excluded.value, unit = excluded.unit, source = excluded.source,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING (xmax = 0) AS inserted
    )
    SELECT (count(*) FILTER (WHERE inserted))::int AS inserted, (count(*) FILTER (WHERE NOT inserted))::int AS updated FROM up
  `.execute(db);
  return result[0] ?? { inserted: 0, updated: 0 };
}
