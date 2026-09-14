import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_CLASSES, METRIC_DEFS } from '@/db/seed/catalog';
import { SIM_SITES } from '@/db/seed/sites';
import { seedDatabase, type SeedOptions } from '@/lib/db/seed';
import type { DB } from '@/lib/db/types';
import { decodeEncryptionKey, decryptGatewaySecret } from '@/lib/ingest/key-crypto';
import { assertTestDatabaseUrl } from '../support/test-env';

const databaseUrl = assertTestDatabaseUrl(process.env.DATABASE_URL);

function seedOptions(): SeedOptions {
  const base64Key = process.env.INGEST_KEY_ENC_KEY;
  if (!base64Key) throw new Error('.env.test.local에 INGEST_KEY_ENC_KEY를 넣으세요 (.env.example 참고).');
  // db:seed:test가 만든 비밀값이 있으면 그대로 써서 테스트 DB의 키가 env 파일과 어긋나지 않게 한다.
  const gatewaySecrets = new Map(
    SIM_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]),
  );
  return { encryptionKey: decodeEncryptionKey(base64Key), gatewaySecrets };
}

interface Snapshot {
  readonly sites: readonly { id: number; code: string }[];
  readonly gateways: readonly { id: number; code: string }[];
  readonly counts: Readonly<Record<string, number>>;
}

describe('seedDatabase (hysol_test)', () => {
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }) });
  const options = seedOptions();
  const expectedAssets = SIM_SITES.reduce((sum, site) => sum + site.assets.length, 0);
  const expectedPoints = SIM_SITES.reduce((sum, site) => sum + site.assets.reduce((n, a) => n + a.points.length, 0), 0);

  async function snapshot(): Promise<Snapshot> {
    const count = async (table: 'om.asset_class' | 'om.metric_def' | 'om.asset' | 'om.point' | 'om.gateway_key') => {
      const row = await db.selectFrom(table).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      return row.n;
    };
    return {
      sites: await db.selectFrom('om.site').select(['id', 'code']).where('code', 'like', 'SIM-%').orderBy('code').execute(),
      gateways: await db.selectFrom('om.gateway').select(['id', 'code']).where('code', 'like', 'GW-SIM%').orderBy('code').execute(),
      counts: {
        assetClasses: await count('om.asset_class'),
        metricDefs: await count('om.metric_def'),
        assets: await count('om.asset'),
        points: await count('om.point'),
        gatewayKeys: await count('om.gateway_key'),
      },
    };
  }

  let first: Snapshot;

  beforeAll(async () => {
    await seedDatabase(db, options);
    first = await snapshot();
  });
  afterAll(() => db.destroy());

  it('정의한 카탈로그·사이트·설비·포인트가 모두 들어간다', async () => {
    expect(first.sites.map((site) => site.code)).toEqual(['SIM-A', 'SIM-B', 'SIM-C']);
    expect(first.gateways.map((gateway) => gateway.code)).toEqual(['GW-SIMA-01', 'GW-SIMB-01', 'GW-SIMC-01']);
    expect(first.counts).toMatchObject({
      assetClasses: ASSET_CLASSES.length,
      metricDefs: METRIC_DEFS.length,
      assets: expectedAssets,
      points: expectedPoints,
    });
  });

  it('두 번 실행해도 행 수와 id가 그대로다 (멱등)', async () => {
    const summary = await seedDatabase(db, options);

    expect(summary).toEqual({
      assetClasses: ASSET_CLASSES.length,
      metricDefs: METRIC_DEFS.length,
      sites: 3,
      assets: expectedAssets,
      gateways: 3,
      points: expectedPoints,
    });
    expect(await snapshot()).toEqual(first);
  });

  it('설비 트리의 parent_id·path가 정의와 일치한다', async () => {
    const rows = await db
      .selectFrom('om.asset as child')
      .innerJoin('om.asset as parent', 'parent.id', 'child.parent_id')
      .select(['child.path as child', 'parent.path as parent'])
      .where('child.path', 'in', ['SIM-B/ELZ1/STACK1', 'SIM-A/PV1/INV02/MPPT1', 'SIM-C/H2BANK1/TANK4'])
      .orderBy('child.path')
      .execute();

    expect(rows).toEqual([
      { child: 'SIM-A/PV1/INV02/MPPT1', parent: 'SIM-A/PV1/INV02' },
      { child: 'SIM-B/ELZ1/STACK1', parent: 'SIM-B/ELZ1' },
      { child: 'SIM-C/H2BANK1/TANK4', parent: 'SIM-C/H2BANK1' },
    ]);
  });

  it('게이트웨이 키는 암호화돼 저장되고 같은 키로 복호화된다', async () => {
    const keys = await db
      .selectFrom('om.gateway_key as k')
      .innerJoin('om.gateway as g', 'g.id', 'k.gateway_id')
      .select(['g.code', 'k.key_id', 'k.secret_enc', 'k.revoked_at'])
      .where('g.code', 'like', 'GW-SIM%')
      .orderBy('g.code')
      .execute();

    expect(keys.map((key) => key.key_id)).toEqual(['gk_sim-a_dev', 'gk_sim-b_dev', 'gk_sim-c_dev']);
    for (const key of keys) {
      const secret = options.gatewaySecrets.get(key.code);
      expect(key.revoked_at).toBeNull();
      expect(key.secret_enc.includes(Buffer.from(secret ?? '', 'utf8'))).toBe(false);
      expect(decryptGatewaySecret(key.secret_enc, options.encryptionKey, key.key_id)).toBe(secret);
    }
  });

  it('포인트는 게이트웨이 태그와 메트릭을 매핑하고, 미매핑 예정 태그는 포인트로 만들지 않는다', async () => {
    const rack = await db
      .selectFrom('om.point as p')
      .innerJoin('om.gateway as g', 'g.id', 'p.gateway_id')
      .select(['p.metric_key', 'p.period_s', 'p.source_unit', 'p.scale'])
      .where('g.code', '=', 'GW-SIMA-01')
      .where('p.source_key', 'in', ['ESS1/RACK03/I_DC', 'ESS1/RACK03/V_CELL_MAX'])
      .orderBy('p.source_key')
      .execute();
    const unmappedKeys = SIM_SITES.flatMap((site) => site.unmappedTags.map((tag) => tag.sourceKey));
    const unmapped = await db
      .selectFrom('om.point as p')
      .innerJoin('om.gateway as g', 'g.id', 'p.gateway_id')
      .select('p.source_key')
      .where('g.code', '=', 'GW-SIMB-01')
      .where('p.source_key', 'in', unmappedKeys)
      .execute();

    expect(rack).toEqual([
      { metric_key: 'batt.current', period_s: 60, source_unit: 'A', scale: 1 },
      { metric_key: 'cell.voltage.max', period_s: 60, source_unit: 'mV', scale: 0.001 },
    ]);
    expect(unmappedKeys).toHaveLength(2);
    expect(unmapped).toEqual([]);
  });

  it('jsonb 컬럼은 배열·객체 그대로 저장된다', async () => {
    const metric = await db
      .selectFrom('om.metric_def')
      .select(sql<string>`jsonb_typeof(aliases)`.as('aliasesType'))
      .where('key', '=', 'ac.power')
      .executeTakeFirstOrThrow();
    const asset = await db
      .selectFrom('om.asset')
      .select('nameplate')
      .where('path', '=', 'SIM-B/ELZ1/STACK1')
      .executeTakeFirstOrThrow();

    expect(metric.aliasesType).toBe('array');
    expect(asset.nameplate).toMatchObject({ cell_count: 210, active_area_cm2: 550 });
  });
});
