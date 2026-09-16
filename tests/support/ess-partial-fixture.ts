// 조치 효과 검증 integration 테스트 전용 사이트: 부분 사이클로만 운전하는 ESS 랙 1개 (연계형 사이트 모양).
// 하루 일정 (UTC): 00:00 휴지(SOC 35) → 02:00~10:00 충전 → 10:00~12:00 휴지(SOC 65) → 12:00~20:00 방전 → 20:00 휴지.
// SOC 변화가 30%p뿐이라 만충 앵커·CV 종료·40%p SOC 변화가 없다 → 충전 세션 용량(앵커·CC·SOC 변화)이 모두 비고,
// 휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC(휴지 앵커)만 유효용량을 준다. 유효용량은 stepDay 전후로 바뀐다(용량 회복 조치).
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { SEED_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import { dropAnalysisFixture } from './analysis-fixture';
import { testEncryptionKey } from './ingest-fixture';

export const ESS_PARTIAL_SITE = 'IT-ESS-PARTIAL';
export const ESS_PARTIAL_BASE_MS = Date.UTC(2026, 7, 1); // 2026-08-01T00:00Z
export const RATED_CAPACITY_AH = 400;
/** 휴지 앵커 SOC 두 점 (차이 30%p < minSocSpanPct 40) */
export const SOC_LOW = 35;
export const SOC_HIGH = 65;

export interface EssPartialFixture {
  readonly siteId: number;
  readonly plantId: number;
  readonly rackId: number;
  readonly pointIds: readonly number[];
}

export interface EssPartialOptions {
  readonly days: number;
  /** 이 날부터 유효용량이 afterAh로 바뀐다 */
  readonly stepDay: number;
  readonly beforeAh: number;
  readonly afterAh: number;
}

async function insertMeasurements(db: Kysely<DB>, points: Readonly<Record<string, number>>, o: EssPartialOptions): Promise<void> {
  const span = SOC_HIGH - SOC_LOW;
  await sql`
    WITH minutes AS (
      SELECT d, m, ${ESS_PARTIAL_BASE_MS}::float8 + (d::float8 * 86400000 + m * 60000) AS ts_ms,
        CASE WHEN d >= ${o.stepDay} THEN ${o.afterAh}::float8 ELSE ${o.beforeAh}::float8 END AS cap
      FROM generate_series(0, ${o.days - 1}) AS d, generate_series(0, 1439) AS m
    ),
    shaped AS (
      SELECT d, m, ts_ms,
        CASE
          WHEN m >= 120 AND m < 600 THEN ${span}::float8 / 100 * cap / 8.0
          WHEN m >= 720 AND m < 1200 THEN -${span}::float8 / 100 * cap / 8.0
          ELSE 0.0
        END AS current,
        CASE
          WHEN m < 120 THEN ${SOC_LOW}::float8
          WHEN m < 600 THEN ${SOC_LOW}::float8 + ${span}::float8 * (m - 120) / 480.0
          WHEN m < 720 THEN ${SOC_HIGH}::float8
          WHEN m < 1200 THEN ${SOC_HIGH}::float8 - ${span}::float8 * (m - 720) / 480.0
          ELSE ${SOC_LOW}::float8
        END AS soc
      FROM minutes
    ),
    values_ AS (
      SELECT ${points.current}::int AS point_id, ts_ms, current AS value FROM shaped
      UNION ALL
      SELECT ${points.voltage}, ts_ms, 780.0 + 0.6 * soc FROM shaped
      UNION ALL
      SELECT ${points.soc}, ts_ms, soc FROM shaped
      UNION ALL
      SELECT ${points.temp}, ts_ms, 26.0 FROM shaped WHERE m % 5 = 0
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

export async function createEssPartialFixture(db: Kysely<DB>, o: EssPartialOptions): Promise<EssPartialFixture> {
  const gatewaySecrets = new Map(SEED_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
  await seedDatabase(db, { encryptionKey: testEncryptionKey(), gatewaySecrets });
  await dropAnalysisFixture(db, ESS_PARTIAL_SITE);
  const site = await db.insertInto('om.site').values({ code: ESS_PARTIAL_SITE, name: '부분 사이클 ESS 테스트 사이트' }).returning('id').executeTakeFirstOrThrow();
  const plant = await db.insertInto('om.asset').values({ site_id: site.id, level: 'asset', class_key: 'ess.plant', code: 'ESS1', path: `${ESS_PARTIAL_SITE}/ESS1`, name: 'ESS' }).returning('id').executeTakeFirstOrThrow();
  const rack = await db
    .insertInto('om.asset')
    .values({
      site_id: site.id,
      parent_id: plant.id,
      level: 'component',
      class_key: 'ess.rack',
      code: 'ESS1/RACK01',
      path: `${ESS_PARTIAL_SITE}/ESS1/RACK01`,
      name: '랙 1',
      nameplate: JSON.stringify({ capacity_ah: RATED_CAPACITY_AH, cell_count: 240 }),
      commissioned_at: '2025-01-01',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const gateway = await db.insertInto('om.gateway').values({ site_id: site.id, code: 'GW-IT-ESS-PARTIAL-01' }).returning('id').executeTakeFirstOrThrow();
  const specs = [
    ['current', 'batt.current', 'ESS1/RACK01/I_DC', 60],
    ['voltage', 'batt.voltage', 'ESS1/RACK01/V_DC', 60],
    ['soc', 'batt.soc', 'ESS1/RACK01/SOC', 60],
    ['temp', 'cell.temp.avg', 'ESS1/RACK01/T_CELL_AVG', 300],
  ] as const;
  const rows = await db
    .insertInto('om.point')
    .values(specs.map(([, metric, sourceKey, periodS]) => ({ asset_id: rack.id, metric_key: metric, gateway_id: gateway.id, source_key: sourceKey, period_s: periodS })))
    .returning(['id', 'source_key'])
    .execute();
  const idOf = (sourceKey: string): number => rows.find((r) => r.source_key === sourceKey)?.id ?? 0;
  const points = Object.fromEntries(specs.map(([name, , sourceKey]) => [name, idOf(sourceKey)]));
  await insertMeasurements(db, points, o);
  return { siteId: site.id, plantId: plant.id, rackId: rack.id, pointIds: Object.values(points) };
}
