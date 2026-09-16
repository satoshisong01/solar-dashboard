// 수집 integration 테스트 전용 사이트·게이트웨이·포인트. 시뮬레이터 사이트(SIM-*)와 섞이지 않도록 따로 만들고 끝나면 지운다.
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { SEED_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import type { IngestEnvelopeInput } from '@/lib/ingest/envelope';
import type { IngestDeps } from '@/lib/ingest/handler';
import { decodeEncryptionKey } from '@/lib/ingest/key-crypto';
import { issueGatewayKey } from '@/lib/ingest/keys';
import { BAD_MASK } from '@/lib/ingest/quality';
import { signBatch } from '@/lib/ingest/signature';
import { assertTestDatabaseUrl } from './test-env';

export const FIXTURE_SITE = 'IT-INGEST';
export const FIXTURE_GATEWAY = 'GW-IT-INGEST-01';

/** 원본 태그 → (설비 코드, 메트릭, scale) */
export const FIXTURE_POINTS = {
  I_DC: { sourceKey: 'ESS1/RACK01/I_DC', asset: 'ESS1/RACK01', metric: 'batt.current', scale: 1 },
  SOC: { sourceKey: 'ESS1/RACK01/SOC', asset: 'ESS1/RACK01', metric: 'batt.soc', scale: 1 },
  V_CELL_MAX: { sourceKey: 'ESS1/RACK01/V_CELL_MAX', asset: 'ESS1/RACK01', metric: 'cell.voltage.max', scale: 0.001 },
} as const;
/** 처음에는 매핑하지 않는 태그 (매핑 → 재처리 시나리오) */
export const FIXTURE_UNMAPPED = { sourceKey: 'COMP1/VIB_RMS', asset: 'COMP1', metric: 'vibration.rms' } as const;

const FIXTURE_ASSETS = [
  { code: 'ESS1', classKey: 'ess.plant', level: 'system' },
  { code: 'ESS1/RACK01', classKey: 'ess.rack', level: 'asset' },
  { code: 'COMP1', classKey: 'h2.compressor', level: 'asset' },
  { code: 'GD1', classKey: 'h2.detector', level: 'asset' },
] as const;

export interface IngestFixture {
  readonly siteId: number;
  readonly gatewayId: number;
  readonly keyId: string;
  readonly secret: string;
  readonly encryptionKey: Uint8Array;
  readonly assetIds: ReadonlyMap<string, number>;
  readonly pointIds: Readonly<Record<keyof typeof FIXTURE_POINTS, number>>;
}

export function createTestDb(): Kysely<DB> {
  const connectionString = assertTestDatabaseUrl(process.env.DATABASE_URL);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 4 }) }) });
}

export function testEncryptionKey(): Uint8Array {
  const base64Key = process.env.INGEST_KEY_ENC_KEY;
  if (!base64Key) throw new Error('.env.test.local에 INGEST_KEY_ENC_KEY를 넣으세요 (.env.example 참고).');
  return decodeEncryptionKey(base64Key);
}

/** 이전 실행이 중간에 멈춰 남긴 행까지 픽스처 사이트의 모든 데이터를 지운다. */
export async function dropIngestFixture(db: Kysely<DB>): Promise<void> {
  const site = await db.selectFrom('om.site').select('id').where('code', '=', FIXTURE_SITE).executeTakeFirst();
  if (!site) return;
  await db.transaction().execute(async (trx) => {
    const gateways = trx.selectFrom('om.gateway').select('id').where('site_id', '=', site.id);
    const points = trx.selectFrom('om.point').select('id').where('gateway_id', 'in', gateways);
    await trx.deleteFrom('om.measurement').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.m_1h').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.rollup_dirty').where('point_id', 'in', points).execute();
    await trx.deleteFrom('om.event_log').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.unmapped_source').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.ingest_batch').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.point').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.gateway_key').where('gateway_id', 'in', gateways).execute();
    await trx.deleteFrom('om.gateway').where('site_id', '=', site.id).execute();
    await trx.deleteFrom('om.asset').where('site_id', '=', site.id).execute(); // 자기참조 FK는 문장 끝에 검사
    await trx.deleteFrom('om.site').where('id', '=', site.id).execute();
  });
}

/** 카탈로그 시드(멱등) → 픽스처 사이트·설비·게이트웨이·포인트 → 키 발급 */
export async function createIngestFixture(db: Kysely<DB>): Promise<IngestFixture> {
  const encryptionKey = testEncryptionKey();
  // db:seed:test가 만든 비밀값이 있으면 그대로 써서 SIM 게이트웨이 키가 env 파일과 어긋나지 않게 한다.
  const gatewaySecrets = new Map(SEED_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
  await seedDatabase(db, { encryptionKey, gatewaySecrets });
  await dropIngestFixture(db);

  const site = await db.insertInto('om.site').values({ code: FIXTURE_SITE, name: '수집 테스트 사이트' }).returning('id').executeTakeFirstOrThrow();
  const assetIds = new Map<string, number>();
  for (const asset of FIXTURE_ASSETS) {
    const parent = asset.code.includes('/') ? assetIds.get(asset.code.slice(0, asset.code.lastIndexOf('/'))) : undefined;
    const row = await db
      .insertInto('om.asset')
      .values({ site_id: site.id, parent_id: parent ?? null, level: asset.level, class_key: asset.classKey, code: asset.code, path: `${FIXTURE_SITE}/${asset.code}`, name: asset.code })
      .returning('id')
      .executeTakeFirstOrThrow();
    assetIds.set(asset.code, row.id);
  }
  const gateway = await db.insertInto('om.gateway').values({ site_id: site.id, code: FIXTURE_GATEWAY }).returning('id').executeTakeFirstOrThrow();

  const assetIdOf = (code: string) => {
    const id = assetIds.get(code);
    if (id === undefined) throw new Error(`픽스처 설비가 없습니다: ${code}`);
    return id;
  };
  const points = await db
    .insertInto('om.point')
    .values(
      Object.values(FIXTURE_POINTS).map((point) => ({
        asset_id: assetIdOf(point.asset),
        metric_key: point.metric,
        gateway_id: gateway.id,
        source_key: point.sourceKey,
        scale: point.scale,
      })),
    )
    .returning(['id', 'source_key'])
    .execute();
  const pointIdOf = (sourceKey: string) => {
    const row = points.find((point) => point.source_key === sourceKey);
    if (!row) throw new Error(`픽스처 포인트가 없습니다: ${sourceKey}`);
    return row.id;
  };
  const pointIds = {
    I_DC: pointIdOf(FIXTURE_POINTS.I_DC.sourceKey),
    SOC: pointIdOf(FIXTURE_POINTS.SOC.sourceKey),
    V_CELL_MAX: pointIdOf(FIXTURE_POINTS.V_CELL_MAX.sourceKey),
  };

  const key = await issueGatewayKey(db, { gatewayId: gateway.id, encryptionKey });
  return { siteId: site.id, gatewayId: gateway.id, keyId: key.keyId, secret: key.secret, encryptionKey, assetIds, pointIds };
}

/** 픽스처 게이트웨이로 보내는 봉투 (series·events 외 기본값 채움) */
export function fixtureEnvelope(sentAtMs: number, parts: Pick<IngestEnvelopeInput, 'series'> & Partial<IngestEnvelopeInput>): IngestEnvelopeInput {
  return {
    schema: 'om.ingest.v1',
    gateway: FIXTURE_GATEWAY,
    batch_id: randomUUID(),
    seq: 1,
    sent_at: new Date(sentAtMs).toISOString(),
    clock: { ntp_synced: true, ntp_offset_ms: 0 },
    events: [],
    ...parts,
  };
}

export interface SignedRequestOptions {
  readonly keyId: string;
  readonly secret: string;
  readonly signedAtMs: number;
  /** 서명 뒤 헤더를 덮어쓴다 (변조 시나리오) */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 봉투를 gzip·서명해 실제 라우트와 같은 Request를 만든다. */
export function signedRequest(envelope: unknown, options: SignedRequestOptions): Request {
  const body = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
  const signature = signBatch(options.keyId, options.secret, Math.floor(options.signedAtMs / 1000), body);
  return new Request('http://localhost/api/ingest/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...signature, ...options.headers },
    body,
  });
}

/** 테스트용 의존성: 시각 고정, after() 대신 작업을 모아 두었다가 runScheduled로 실행한다. */
export function testDeps(db: Kysely<DB>, fixture: IngestFixture, nowMs: number, overrides: Partial<IngestDeps> = {}) {
  const scheduled: (() => Promise<void>)[] = [];
  const deps: IngestDeps = {
    db,
    encryptionKey: () => fixture.encryptionKey,
    nowMs: () => nowMs,
    isDbSaturated: () => false,
    schedule: (task) => {
      scheduled.push(task);
    },
    ...overrides,
  };
  const runScheduled = async () => {
    const tasks = scheduled.splice(0);
    for (const task of tasks) await task();
    return tasks.length;
  };
  return { deps, runScheduled };
}

/** m_1h와 원시 재집계(lib/ingest/rollup의 NULL·BAD 비트 규칙)가 다른 (포인트, 버킷) 수와 비교한 버킷 수. 모든 열을 IS DISTINCT FROM으로 비교한다. */
export async function compareRollupWithRaw(db: Kysely<DB>, pointIds: readonly number[]): Promise<{ buckets: number; mismatches: number }> {
  const { rows } = await sql<{ buckets: number; mismatches: number }>`
    WITH raw AS (
      SELECT point_id, date_trunc('hour', ts, 'UTC') AS bucket,
        count(*)::int AS n, (count(*) FILTER (WHERE value IS NOT NULL AND (quality & ${BAD_MASK}::int2) = 0))::int AS n_good,
        min(value) AS v_min, max(value) AS v_max, avg(value) AS v_avg,
        (array_agg(value ORDER BY ts) FILTER (WHERE value IS NOT NULL))[1] AS v_first,
        (array_agg(value ORDER BY ts DESC) FILTER (WHERE value IS NOT NULL))[1] AS v_last, sum(value) AS v_sum
      FROM om.measurement WHERE point_id = ANY(${[...pointIds]}::int4[])
      GROUP BY 1, 2
    ),
    rolled AS (SELECT * FROM om.m_1h WHERE point_id = ANY(${[...pointIds]}::int4[]))
    SELECT count(*)::int AS buckets,
      (count(*) FILTER (WHERE
        (raw.n, raw.n_good, raw.v_min, raw.v_max, raw.v_avg, raw.v_first, raw.v_last, raw.v_sum)
        IS DISTINCT FROM (rolled.n, rolled.n_good, rolled.v_min, rolled.v_max, rolled.v_avg, rolled.v_first, rolled.v_last, rolled.v_sum)
      ))::int AS mismatches
    FROM raw FULL JOIN rolled USING (point_id, bucket)
  `.execute(db);
  return rows[0] ?? { buckets: 0, mismatches: 0 };
}
