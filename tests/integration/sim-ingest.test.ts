// 시뮬레이터 → HTTP 전송기(서명·gzip) → 수집 핸들러 → DB → 적재 검증까지 한 번에 확인한다 (서버 없이 fetch를 핸들러로 연결).
// 테스트 DB에는 몇 시간치만 넣고 끝나면 SIM 사이트 수집 데이터를 지운다.
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import { handleIngestRequest, type IngestDeps } from '@/lib/ingest/handler';
import { drainAllDirty, observeRollup, observeSites } from '@/lib/ingest/verify-queries';
import { runBatches } from '@/lib/sim/batch-runner';
import { createHttpEmitter } from '@/lib/sim/emit-http';
import { simulate } from '@/lib/sim/index';
import type { RunSummary } from '@/lib/sim/manifest';
import { evaluateIngest, type VerifyExpectation } from '@/lib/sim/verify-checks';
import { createTestDb, testEncryptionKey } from '../support/ingest-fixture';

const HOUR = 3_600_000;
const FROM = Date.parse('2026-08-20T09:00:00+09:00');
const SITES = ['SIM-A', 'SIM-B'] as const;

async function clearSimIngestData(db: Kysely<DB>): Promise<void> {
  const codes = SIM_SITES.map((site) => site.code);
  await db.transaction().execute(async (trx) => {
    const sites = trx.selectFrom('om.site').select('id').where('code', 'in', codes);
    const gateways = trx.selectFrom('om.gateway').select('id').where('site_id', 'in', sites);
    const points = trx.selectFrom('om.point').select('id').where('gateway_id', 'in', gateways);
    await trx.deleteFrom('om.measurement').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.m_1h').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.rollup_dirty').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.event_log').where('site_id', 'in', sites).execute();
    await trx.deleteFrom('om.unmapped_source').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.ingest_batch').where('gateway_id', 'in', gateways).execute();
  });
}

describe('시뮬레이터 적재와 검증 (hysol_test)', () => {
  const db = createTestDb();
  let summary: RunSummary;
  let expectation: VerifyExpectation;

  beforeAll(async () => {
    const encryptionKey = testEncryptionKey();
    const secrets = new Map(SIM_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
    await seedDatabase(db, { encryptionKey, gatewaySecrets: secrets });
    await clearSimIngestData(db);

    // 실시간 재생: 서버 시각 = 배치의 실제 전송 시각
    let nowMs = FROM;
    const scheduled: (() => Promise<void>)[] = [];
    const deps: IngestDeps = { db, encryptionKey: () => encryptionKey, nowMs: () => nowMs, isDbSaturated: () => false, schedule: (task) => void scheduled.push(task) };
    const emitter = createHttpEmitter({
      baseUrl: 'http://sim.test',
      credentials: new Map(SIM_SITES.map(({ gateway }) => [gateway.code, { keyId: gateway.keyId, secret: secrets.get(gateway.code) ?? '' }])),
      fetch: async (input, init) => handleIngestRequest(new Request(input, init), deps),
      nowMs: () => nowMs,
    });

    const batches = simulate({
      siteCodes: SITES,
      from: FROM,
      to: FROM + 3 * HOUR,
      seed: 42,
      scenarios: [
        { kind: 'dq.duplicate_batches', site: 'SIM-A', ratio: 0.3 },
        { kind: 'dq.duplicate_batches', site: 'SIM-B', ratio: 0.3 },
        { kind: 'dq.clock_skew', site: 'SIM-A', skewS: 200, start: FROM + HOUR, durationS: 3_600 },
        { kind: 'dq.gateway_outage', site: 'SIM-B', start: FROM + 0.5 * HOUR, durationS: 5_400 },
        { kind: 'safety.h2_leak_alarm', site: 'SIM-B', at: FROM + 2.5 * HOUR },
      ],
    });
    summary = await runBatches(batches, {
      concurrency: 1,
      emit: async (batch) => {
        nowMs = batch.sentAtMs;
        const result = await emitter.emit(batch);
        for (const task of scheduled.splice(0)) await task(); // after() 대신
        return result;
      },
    });
    expectation = { sites: summary.sites, intendedUnmapped: new Map(SIM_SITES.map((site) => [site.code, site.unmappedTags.map((tag) => tag.sourceKey)])) };
  }, 120_000);

  afterAll(async () => {
    await clearSimIngestData(db);
    await db.destroy();
  });

  async function observe() {
    const { remaining } = await drainAllDirty(db);
    const window = summary.sampleWindow;
    if (!window) throw new Error('샘플 시각 범위가 없습니다');
    return { sites: await observeSites(db, SITES, window), rollup: { ...(await observeRollup(db)), dirtyRemaining: remaining } };
  }

  it('모든 배치가 accepted·duplicate로 끝나고 재전송은 duplicate다', () => {
    expect(summary.results).toMatchObject({ failed: 0, conflict: 0 });
    expect(summary.results.duplicate).toBe(summary.resends);
    expect(summary.resends).toBeGreaterThan(0);
    expect(summary.backfillBatches).toBeGreaterThan(0);
    expect(summary.samples.accepted).toBe(Object.values(summary.sites).reduce((sum, site) => sum + site.expectedSamples, 0));
  });

  it('verify 판정 (a)~(e)가 모두 통과한다', async () => {
    const checks = evaluateIngest(expectation, await observe());

    expect(checks.map((check) => [check.id, check.status, check.details])).toEqual(checks.map((check) => [check.id, 'pass', check.details]));
  });

  it('원시 행 하나가 사라지면 (a) 행 수와 (b) 롤업 비교가 실패한다', async () => {
    await sql`
      DELETE FROM om.measurement WHERE (point_id, ts) IN (
        SELECT m.point_id, m.ts FROM om.measurement m
        JOIN om.point p ON p.id = m.point_id JOIN om.gateway g ON g.id = p.gateway_id
        WHERE g.code = ${'GW-SIMA-01'} LIMIT 1
      )
    `.execute(db);
    const statuses = Object.fromEntries(evaluateIngest(expectation, await observe()).map((check) => [check.id, check.status]));

    expect(statuses).toMatchObject({ a: 'fail', b: 'fail' });
  });
});
