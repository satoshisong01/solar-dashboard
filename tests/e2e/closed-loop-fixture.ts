// E2E globalSetup 전용: 폐루프 시나리오(closed-loop-plan.ts)의 SIM-A 80일을 메모리 모드 시뮬레이터로 만들어 테스트 DB 원시에 직접 넣는다.
// 수집 API 경로는 sim-ingest.ts(SIM-B 최근 2일)가 그대로 검증한다. 여기서는 80일 × 1분을 HTTP로 보내는 시간을 줄이려고
// 수집 파이프라인이 저장할 값(메모리 모드 = 원본값 × scale + offset, HARD_RANGE 품질)을 그대로 넣고 1시간 롤업을 다시 집계한다.
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DB } from '../../lib/db/types';
import { rebuildHourlyRollups } from '../../lib/ingest/rollup';
import { simulateMemory, type MemorySeries } from '../../lib/sim/memory';
import { LOOP_DAYS, LOOP_SEED, LOOP_SITE, loopScenarios, loopWindowMs } from './closed-loop-plan';

const INSERT_CHUNK = 50_000;
const INSERT_CONCURRENCY = 4;
const ROLLUP_CHUNK_MS = 7 * 86_400_000;
const MONTH_PARTITIONS = 4;

export interface LoopFixtureSummary {
  readonly points: number;
  readonly samples: number;
  readonly rollupRows: number;
  readonly elapsedMs: number;
}

async function pointIdsBySourceKey(db: Kysely<DB>): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .selectFrom('om.point as p')
    .innerJoin('om.gateway as g', 'g.id', 'p.gateway_id')
    .innerJoin('om.site as s', 's.id', 'g.site_id')
    .select(['p.id', 'p.source_key'])
    .where('s.code', '=', LOOP_SITE)
    .execute();
  return new Map(rows.map((row) => [row.source_key, row.id]));
}

interface InsertJob {
  readonly pointId: number;
  readonly series: MemorySeries;
  readonly offset: number;
}

function insertJobs(series: readonly MemorySeries[], pointIds: ReadonlyMap<string, number>): InsertJob[] {
  return series.flatMap((s) => {
    const pointId = pointIds.get(s.sourceKey);
    if (pointId === undefined) throw new Error(`${LOOP_SITE} 시드에 없는 포인트입니다: ${s.sourceKey}`);
    return Array.from({ length: Math.ceil(s.ts.length / INSERT_CHUNK) }, (_, i) => ({ pointId, series: s, offset: i * INSERT_CHUNK }));
  });
}

async function insertChunk(pool: pg.Pool, job: InsertJob): Promise<void> {
  const end = Math.min(job.offset + INSERT_CHUNK, job.series.ts.length);
  await pool.query(
    `INSERT INTO om.measurement (point_id, ts, value, quality)
     SELECT $1::int4, to_timestamp(u.t / 1000.0), u.v, u.q FROM unnest($2::float8[], $3::float8[], $4::int2[]) AS u(t, v, q)`,
    [job.pointId, Array.from(job.series.ts.subarray(job.offset, end)), Array.from(job.series.value.subarray(job.offset, end)), Array.from(job.series.quality.subarray(job.offset, end))],
  );
}

async function insertAll(pool: pg.Pool, jobs: readonly InsertJob[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job) await insertChunk(pool, job);
    }
  };
  await Promise.all(Array.from({ length: INSERT_CONCURRENCY }, worker));
}

async function rebuildRollups(db: Kysely<DB>): Promise<number> {
  let upserted = 0;
  for (let from = loopWindowMs.from; from < loopWindowMs.to; from += ROLLUP_CHUNK_MS) {
    upserted += await rebuildHourlyRollups(db, { fromMs: from, toMs: Math.min(loopWindowMs.to, from + ROLLUP_CHUNK_MS) });
  }
  return upserted;
}

/** 시드가 끝난 테스트 DB에 적재한다. 같은 DB에 두 번 넣으면 기본키 충돌로 실패한다 (globalSetup이 매번 초기화). */
export async function loadClosedLoopFixture(databaseUrl: string): Promise<LoopFixtureSummary> {
  const startedAt = Date.now();
  const simulated = simulateMemory({ siteCodes: [LOOP_SITE], from: loopWindowMs.from, to: loopWindowMs.to, seed: LOOP_SEED, scenarios: loopScenarios() });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: INSERT_CONCURRENCY });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  try {
    const jobs = insertJobs([...simulated.series.values()], await pointIdsBySourceKey(db));
    await sql`SELECT om.ensure_measurement_partitions(${new Date(loopWindowMs.from).toISOString().slice(0, 10)}::date, ${MONTH_PARTITIONS}::int4)`.execute(db);
    await insertAll(pool, jobs);
    await sql`ANALYZE om.measurement`.execute(db);
    const rollupRows = await rebuildRollups(db);
    const summary = { points: simulated.series.size, samples: simulated.stats.samples, rollupRows, elapsedMs: Date.now() - startedAt };
    console.log(`[e2e] ${LOOP_SITE} 폐루프 픽스처 ${LOOP_DAYS}일: 포인트 ${summary.points} · 샘플 ${summary.samples} · 1시간 롤업 ${summary.rollupRows} · ${summary.elapsedMs} ms`);
    return summary;
  } finally {
    await db.destroy(); // pool도 함께 닫힌다
  }
}
