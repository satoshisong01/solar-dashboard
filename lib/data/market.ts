import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { isMarketKey, MARKET_LABELS } from '@/lib/market/keys';

export interface MarketEntryRow {
  readonly day: string;
  readonly marketKey: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly updatedBy: string | null;
  readonly updatedAtMs: number;
}

/** 최근 날짜부터 입력 기록 (date는 문자열로 읽어 시간대 변환을 피한다) */
export async function listRecentMarketEntries(limit: number): Promise<readonly MarketEntryRow[]> {
  const { rows } = await sql<{
    day: string;
    market_key: string;
    value: number;
    unit: string;
    source: string;
    updated_by: string | null;
    updated_at_ms: number;
  }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, market_key, value::float8 AS value, unit, source, updated_by,
      (extract(epoch FROM updated_at) * 1000)::float8 AS updated_at_ms
    FROM om.market_daily
    ORDER BY day DESC, market_key
    LIMIT ${limit}
  `.execute(db);
  return rows.map((row) => ({
    day: row.day,
    marketKey: row.market_key,
    label: isMarketKey(row.market_key) ? MARKET_LABELS[row.market_key] : row.market_key,
    value: row.value,
    unit: row.unit,
    source: row.source,
    updatedBy: row.updated_by,
    updatedAtMs: row.updated_at_ms,
  }));
}
