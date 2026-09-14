// 분석 실행 integration 테스트 전용 사이트: 전해조 스택 1개의 합성 원시(서버 쪽 generate_series로 생성).
//   하루 두 번 5시간씩 1000 A 정상운전, 셀 전압 = 1.90 V + 30 µV/h × (누적 운전시간 − 2000 h), stepDay 이후 −10 mV(조치 효과)
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { SIM_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import { testEncryptionKey } from './ingest-fixture';

export const ANALYSIS_SITE = 'IT-ANALYSIS';
export const ANALYSIS_BASE_MS = Date.UTC(2026, 7, 1); // 2026-08-01T00:00Z
export const DAY_MS = 86_400_000;
export const RATE_UV_PER_H = 30;

export interface AnalysisFixture {
  readonly siteId: number;
  readonly elzId: number;
  readonly stackId: number;
  readonly pointIds: readonly number[];
}

/** 픽스처 사이트의 분석 결과·원시·카탈로그 행을 모두 지운다 (FK 순서) */
export async function dropAnalysisFixture(db: Kysely<DB>): Promise<void> {
  const site = await db.selectFrom('om.site').select('id').where('code', '=', ANALYSIS_SITE).executeTakeFirst();
  if (!site) return;
  await db.transaction().execute(async (trx) => {
    const assets = trx.selectFrom('om.asset').select('id').where('site_id', '=', site.id);
    const findings = trx.selectFrom('om.finding').select('id').where('site_id', '=', site.id);
    const actions = trx.selectFrom('om.maintenance_action').select('id').where('site_id', '=', site.id);
    const gateways = trx.selectFrom('om.gateway').select('id').where('site_id', '=', site.id);
    const points = trx.selectFrom('om.point').select('id').where('gateway_id', 'in', gateways);
    await trx.deleteFrom('om.report').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.action_verification').where('action_id', 'in', actions).execute();
    await trx.deleteFrom('om.maintenance_action').where('site_id', '=', site.id).execute();
    await trx.updateTable('om.finding').set({ latest_evidence_id: null, previous_finding_id: null }).where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.finding_transition').where('finding_id', 'in', findings).execute();
    await trx.deleteFrom('om.finding_evidence').where('finding_id', 'in', findings).execute();
    await trx.deleteFrom('om.finding').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.episode').where('asset_id', 'in', assets).execute();
    await trx.deleteFrom('om.kpi_daily').where((eb) => eb.or([eb.and([eb('scope_type', '=', 'site'), eb('scope_id', '=', site.id)]), eb.and([eb('scope_type', '=', 'asset'), eb('scope_id', 'in', assets)])])).execute();
    await sql`DELETE FROM om.analysis_run r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.scope -> 'siteIds') e(id) WHERE e.id::int = ${site.id})`.execute(trx);
    await trx.deleteFrom('om.asset_event').where('asset_id', 'in', assets).execute();
    await trx.deleteFrom('om.rollup_dirty').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.m_1h').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.measurement').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.point').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.gateway').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.asset').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.site').where('id', '=', site.id).execute();
  });
}

async function insertMeasurements(db: Kysely<DB>, points: Readonly<Record<string, number>>, days: number, stepDay: number): Promise<void> {
  await sql`
    WITH minutes AS (
      SELECT d, m, ${ANALYSIS_BASE_MS}::float8 + (d::float8 * 86400000 + m * 60000) AS ts_ms,
        (m >= 60 AND m < 360) OR (m >= 420 AND m < 720) AS running,
        2000 + (d * 600 + least(greatest(m - 60, 0), 300) + least(greatest(m - 420, 0), 300)) / 60.0 AS run_hours
      FROM generate_series(0, ${days - 1}) AS d, generate_series(0, 1439) AS m
    ),
    values_ AS (
      SELECT ${points.current}::int AS point_id, ts_ms, CASE WHEN running THEN 1000.0 ELSE 0.0 END AS value FROM minutes
      UNION ALL
      SELECT ${points.voltage}, ts_ms, CASE WHEN running THEN 210 * (1.90 + ${RATE_UV_PER_H * 1e-6} * (run_hours - 2000) - CASE WHEN d >= ${stepDay} THEN 0.010 ELSE 0 END) ELSE 0.0 END FROM minutes
      UNION ALL
      SELECT ${points.temp}, ts_ms, CASE WHEN running THEN 62 ELSE 30 END + 0.3 * sin(m / 37.0) FROM minutes WHERE m % 5 = 0
      UNION ALL
      SELECT ${points.hours}, ts_ms, run_hours FROM minutes WHERE m % 5 = 0
    )
    INSERT INTO om.measurement (point_id, ts, value, quality)
    SELECT point_id, to_timestamp(ts_ms / 1000), value, 0 FROM values_
  `.execute(db);
  await sql`
    INSERT INTO om.rollup_dirty (point_id, bucket)
    SELECT DISTINCT point_id, date_trunc('hour', ts, 'UTC') FROM om.measurement WHERE point_id = ANY(${Object.values(points)}::int4[])
    ON CONFLICT DO NOTHING
  `.execute(db);
}

/** 카탈로그 시드 → 픽스처 사이트·전해조·스택·게이트웨이·포인트 → 합성 원시 days일 */
export async function createAnalysisFixture(db: Kysely<DB>, days: number, stepDay: number): Promise<AnalysisFixture> {
  const gatewaySecrets = new Map(SIM_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
  await seedDatabase(db, { encryptionKey: testEncryptionKey(), gatewaySecrets });
  await dropAnalysisFixture(db);
  const site = await db.insertInto('om.site').values({ code: ANALYSIS_SITE, name: '분석 테스트 사이트' }).returning('id').executeTakeFirstOrThrow();
  const elz = await db.insertInto('om.asset').values({ site_id: site.id, level: 'asset', class_key: 'h2.elz', code: 'ELZ1', path: `${ANALYSIS_SITE}/ELZ1`, name: '전해조' }).returning('id').executeTakeFirstOrThrow();
  const stack = await db
    .insertInto('om.asset')
    .values({ site_id: site.id, parent_id: elz.id, level: 'component', class_key: 'h2.elz.stack', code: 'ELZ1/STACK1', path: `${ANALYSIS_SITE}/ELZ1/STACK1`, name: '스택', nameplate: JSON.stringify({ cell_count: 210, active_area_cm2: 550, rated_current_a: 1100 }), commissioned_at: '2025-01-01' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const gateway = await db.insertInto('om.gateway').values({ site_id: site.id, code: 'GW-IT-ANALYSIS-01' }).returning('id').executeTakeFirstOrThrow();
  const specs = [
    ['current', 'stack.current', 'ELZ1/STACK1/I', 60],
    ['voltage', 'stack.voltage', 'ELZ1/STACK1/V', 60],
    ['temp', 'stack.temp', 'ELZ1/STACK1/T_OUT', 300],
    ['hours', 'run.hours', 'ELZ1/STACK1/RUN_H', 300],
  ] as const;
  const rows = await db
    .insertInto('om.point')
    .values(specs.map(([, metric, sourceKey, periodS]) => ({ asset_id: stack.id, metric_key: metric, gateway_id: gateway.id, source_key: sourceKey, period_s: periodS })))
    .returning(['id', 'source_key'])
    .execute();
  const idOf = (sourceKey: string): number => rows.find((r) => r.source_key === sourceKey)?.id ?? 0;
  const points = Object.fromEntries(specs.map(([name, , sourceKey]) => [name, idOf(sourceKey)]));
  await insertMeasurements(db, points, days, stepDay);
  return { siteId: site.id, elzId: elz.id, stackId: stack.id, pointIds: Object.values(points) };
}
