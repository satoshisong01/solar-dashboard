// P3 분석 integration 전용: 시드된 SIM-B(연계형)의 수소 체인 포인트를 메모리 모드 시뮬레이터로 21일 만들어 테스트 DB 원시에 직접 넣는다.
//   10일째부터 저장용기 2에 누설 2 kg/일 → tank.static_leak(설비)·h2chain.mass_balance_gap(사이트) finding
// 수집 API 경로는 sim-ingest 테스트가 검증하므로 여기서는 저장값(메모리 모드)을 그대로 넣고 1시간 롤업을 다시 집계한다.
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { SIM_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import { rebuildHourlyRollups } from '@/lib/ingest/rollup';
import { simulateMemory, type MemoryPoint } from '@/lib/sim/memory';
import type { Scenario } from '@/lib/sim/scenarios';
import { testEncryptionKey } from './ingest-fixture';

export const P3_SITE = 'SIM-B';
/** 2026-02-01 00:00 KST (다른 integration 테스트의 SIM-B 적재 시각과 겹치지 않는 과거) */
export const P3_FROM_MS = Date.parse('2026-02-01T00:00:00+09:00');
export const P3_DAYS = 21;
export const P3_DAY_MS = 86_400_000;
export const P3_LEAK_TANK = 'H2BANK1/TANK2';
export const P3_LEAK_DAY = 10;
const SEED = 17;
const INSERT_CHUNK = 20_000;

/** 수소 체인·압축기·연료전지 블로워·기상 포인트만 (P3 수소 탐지기와 원장이 읽는 것) */
const CLASSES: Readonly<Record<string, readonly string[]>> = {
  'h2.elz': ['ac.power', 'h2.flow.mass', 'h2.mass.total'],
  'h2.elz.stack': ['stack.current', 'stack.voltage', 'stack.temp', 'run.hours'],
  'h2.elz.rectifier': ['ac.power', 'rectifier.efficiency'],
  'h2.compressor': ['compressor.power', 'compressor.suction.pressure', 'compressor.discharge.pressure', 'compressor.discharge.temp', 'compressor.leak.pressure', 'run.hours'],
  'h2.storage.bank': ['valve.open', 'h2.inventory'],
  'h2.storage.tank': ['tank.pressure', 'tank.temp'],
  'fc.plant': ['fc.ac.power', 'fc.h2.consumption', 'h2.pressure', 'purge.count'],
  'wx.station': ['ambient.temp'],
};
const pointFilter = (point: MemoryPoint): boolean => CLASSES[point.classKey]?.includes(point.metricKey) ?? false;

const scenarios: readonly Scenario[] = [{ kind: 'fault.tank_leak', site: P3_SITE, tank: P3_LEAK_TANK, kgPerDay: 2, startDay: P3_LEAK_DAY }];

export interface P3Fixture {
  readonly siteId: number;
  readonly assetIdOf: (code: string) => number;
  /** 넣은 포인트 id */
  readonly pointIds: readonly number[];
  readonly samples: number;
}

const window = { start: P3_FROM_MS, end: P3_FROM_MS + P3_DAYS * P3_DAY_MS };
const iso = (ms: number): string => new Date(ms).toISOString();

/** SIM-B 분석 결과·이 구간 원시를 지운다 (FK 순서). 카탈로그(사이트·설비·포인트)는 시드 소유라 남긴다 */
export async function dropP3Fixture(db: Kysely<DB>): Promise<void> {
  const site = await db.selectFrom('om.site').select('id').where('code', '=', P3_SITE).executeTakeFirst();
  if (!site) return;
  await db.transaction().execute(async (trx) => {
    const assets = trx.selectFrom('om.asset').select('id').where('site_id', '=', site.id);
    const findings = trx.selectFrom('om.finding').select('id').where('site_id', '=', site.id);
    const actions = trx.selectFrom('om.maintenance_action').select('id').where('site_id', '=', site.id);
    const points = trx.selectFrom('om.point').select('id').where('asset_id', 'in', assets);
    await trx.deleteFrom('om.report').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.action_verification').where('action_id', 'in', actions).execute();
    await trx.deleteFrom('om.maintenance_action').where('site_id', '=', site.id).execute();
    await trx.updateTable('om.finding').set({ latest_evidence_id: null, previous_finding_id: null }).where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.finding_transition').where('finding_id', 'in', findings).execute();
    await trx.deleteFrom('om.finding_evidence').where('finding_id', 'in', findings).execute();
    await trx.deleteFrom('om.finding').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.site_energy_daily').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.episode').where('asset_id', 'in', assets).execute();
    await trx.deleteFrom('om.kpi_daily').where((eb) => eb.or([eb.and([eb('scope_type', '=', 'site'), eb('scope_id', '=', site.id)]), eb.and([eb('scope_type', '=', 'asset'), eb('scope_id', 'in', assets)])])).execute();
    await trx.deleteFrom('om.detector_config').where('created_by', '=', 'it-p3').execute();
    await sql`DELETE FROM om.analysis_run r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.scope -> 'siteIds') e(id) WHERE e.id::int = ${site.id})`.execute(trx);
    await trx.deleteFrom('om.m_1h').where('point_id', 'in', points).where('bucket', '>=', new Date(window.start - P3_DAY_MS)).where('bucket', '<', new Date(window.end + P3_DAY_MS)).execute();
    await trx.deleteFrom('om.measurement').where('point_id', 'in', points).where('ts', '>=', new Date(window.start - P3_DAY_MS)).where('ts', '<', new Date(window.end + P3_DAY_MS)).execute();
  });
}

async function insertSeries(databaseUrl: string, rows: readonly { pointId: number; ts: Float64Array; value: Float64Array; quality: Int16Array }[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    for (const row of rows) {
      for (let offset = 0; offset < row.ts.length; offset += INSERT_CHUNK) {
        const end = Math.min(row.ts.length, offset + INSERT_CHUNK);
        await pool.query(
          `INSERT INTO om.measurement (point_id, ts, value, quality)
           SELECT $1::int4, to_timestamp(u.t / 1000.0), u.v, u.q FROM unnest($2::float8[], $3::float8[], $4::int2[]) AS u(t, v, q)`,
          [row.pointId, Array.from(row.ts.subarray(offset, end)), Array.from(row.value.subarray(offset, end)), Array.from(row.quality.subarray(offset, end))],
        );
      }
    }
  } finally {
    await pool.end();
  }
}

/** 시드 → 이전 결과 정리 → 시뮬레이션 → 원시 적재 → 1시간 롤업 재집계 */
export async function createP3Fixture(db: Kysely<DB>, databaseUrl: string): Promise<P3Fixture> {
  const gatewaySecrets = new Map(SIM_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
  await seedDatabase(db, { encryptionKey: testEncryptionKey(), gatewaySecrets });
  await dropP3Fixture(db);
  const site = await db.selectFrom('om.site').select('id').where('code', '=', P3_SITE).executeTakeFirstOrThrow();
  const assets = await db.selectFrom('om.asset').select(['id', 'code']).where('site_id', '=', site.id).execute();
  const points = await db.selectFrom('om.point as p').innerJoin('om.asset as a', 'a.id', 'p.asset_id').select(['p.id', 'p.source_key']).where('a.site_id', '=', site.id).execute();
  const pointBySource = new Map(points.map((p) => [p.source_key, p.id]));
  const simulated = simulateMemory({ siteCodes: [P3_SITE], from: window.start, to: window.end, seed: SEED, scenarios, pointFilter });
  const rows = [...simulated.series.values()].map((s) => {
    const pointId = pointBySource.get(s.sourceKey);
    if (pointId === undefined) throw new Error(`시드에 없는 포인트: ${s.sourceKey}`);
    return { pointId, ts: s.ts, value: s.value, quality: s.quality };
  });
  await sql`SELECT om.ensure_measurement_partitions(${iso(window.start).slice(0, 10)}::date, 2::int4)`.execute(db);
  await insertSeries(databaseUrl, rows);
  await rebuildHourlyRollups(db, { fromMs: window.start, toMs: window.end });
  const idOf = new Map(assets.map((a) => [a.code, a.id]));
  return {
    siteId: site.id,
    assetIdOf: (code) => {
      const id = idOf.get(code);
      if (id === undefined) throw new Error(`설비 없음: ${code}`);
      return id;
    },
    pointIds: rows.map((r) => r.pointId),
    samples: simulated.stats.samples,
  };
}

export const p3Window = window;
export const p3At = (day: number): Date => new Date(P3_FROM_MS + day * P3_DAY_MS);
