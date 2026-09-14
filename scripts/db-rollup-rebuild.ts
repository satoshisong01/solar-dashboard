// [로컬 전용] om.m_1h를 원시(om.measurement)에서 전부 다시 집계한다 (npm run db:rollup:rebuild).
// 롤업 규칙이 바뀐 뒤(예: n_good을 BAD 비트 기준으로 변경) 이미 쌓인 과거 롤업을 새 규칙에 맞춘다.
// UTC 하루 단위로 나눠 upsert하며, dirty 대기열은 건드리지 않는다. 여러 번 실행해도 결과가 같다.
// 안전장치: DATABASE_URL이 localhost:54320(embedded-postgres)이 아니면 아무것도 하지 않고 실패한다.
import { sql } from 'kysely';
import { db } from '../lib/db/kysely';
import { getServerEnv } from '../lib/env';
import { rebuildHourlyRollups } from '../lib/ingest/rollup';
import { assertLocalDatabaseUrl, log } from './local-pg';

const DAY_MS = 86_400_000;
const PROGRESS_EVERY_DAYS = 7;

async function sampleRange(): Promise<{ readonly fromMs: number; readonly toMs: number } | null> {
  const { rows } = await sql<{ min_ms: number | null; max_ms: number | null }>`
    SELECT (extract(epoch FROM min(ts)) * 1000)::float8 AS min_ms, (extract(epoch FROM max(ts)) * 1000)::float8 AS max_ms
    FROM om.measurement
  `.execute(db);
  const row = rows[0];
  if (!row || row.min_ms === null || row.max_ms === null) return null;
  return { fromMs: Math.floor(row.min_ms / DAY_MS) * DAY_MS, toMs: Math.floor(row.max_ms / DAY_MS) * DAY_MS + DAY_MS };
}

async function goodRatio(): Promise<{ readonly n: number; readonly nGood: number }> {
  const { rows } = await sql<{ n: number | null; n_good: number | null }>`
    SELECT sum(n)::float8 AS n, sum(n_good)::float8 AS n_good FROM om.m_1h
  `.execute(db);
  return { n: rows[0]?.n ?? 0, nGood: rows[0]?.n_good ?? 0 };
}

async function main(): Promise<void> {
  const url = assertLocalDatabaseUrl(getServerEnv().DATABASE_URL);
  const database = url.pathname.slice(1);
  try {
    const range = await sampleRange();
    if (!range) {
      log(`${database}: 원시 측정값이 없어 재계산할 롤업이 없습니다`);
      return;
    }
    const startedAt = Date.now();
    const days = Math.round((range.toMs - range.fromMs) / DAY_MS);
    log(`${database}: ${new Date(range.fromMs).toISOString().slice(0, 10)} ~ ${new Date(range.toMs - DAY_MS).toISOString().slice(0, 10)} (UTC ${days}일) m_1h 재계산 시작`);

    let upserted = 0;
    for (let day = 0; day < days; day += 1) {
      const fromMs = range.fromMs + day * DAY_MS;
      upserted += await rebuildHourlyRollups(db, { fromMs, toMs: fromMs + DAY_MS });
      if ((day + 1) % PROGRESS_EVERY_DAYS === 0 || day + 1 === days) {
        log(`  ${day + 1}/${days}일 · m_1h ${upserted.toLocaleString('en-US')}행 · ${Math.round((Date.now() - startedAt) / 1_000)}초`);
      }
    }

    const { n, nGood } = await goodRatio();
    const percent = n > 0 ? ((nGood / n) * 100).toFixed(2) : '0.00';
    log(`${database}: 완료 · m_1h ${upserted.toLocaleString('en-US')}행 · n_good/n = ${nGood.toLocaleString('en-US')}/${n.toLocaleString('en-US')} (${percent}%)`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('[db] 롤업 재계산 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
