// 카탈로그·가상 사이트 시드를 DB에 멱등 upsert한다 (npm run db:seed / db:seed:test).
// 데이터 정의는 db/seed/*의 순수 모듈이고, 이 파일은 DB 쓰기만 담당한다.
// 'server-only'를 넣지 않는다: tsx 스크립트와 integration 테스트에서 import한다.
import type { Kysely, Transaction } from 'kysely';
import { ASSET_CLASSES, METRIC_DEFS } from '@/db/seed/catalog';
import { SIM_SITES } from '@/db/seed/sites';
import type { AssetDef, GatewayDef, SiteDef } from '@/db/seed/types';
import { encryptGatewaySecret } from '@/lib/ingest/key-crypto';
import type { DB } from './types';

type Trx = Transaction<DB>;

export interface SeedOptions {
  /** INGEST_KEY_ENC_KEY를 디코딩한 32바이트 키 */
  readonly encryptionKey: Uint8Array;
  /** 게이트웨이 코드 → 개발용 HMAC 비밀값 */
  readonly gatewaySecrets: ReadonlyMap<string, string>;
}

export interface SeedSummary {
  readonly assetClasses: number;
  readonly metricDefs: number;
  readonly sites: number;
  readonly assets: number;
  readonly gateways: number;
  readonly points: number;
}

async function upsertAssetClasses(trx: Trx): Promise<void> {
  // 같은 문장 안의 자기참조 FK는 문장 끝에 검사하므로 부모·자식을 한 번에 넣어도 된다.
  await trx
    .insertInto('om.asset_class')
    .values(
      ASSET_CLASSES.map((c) => ({
        key: c.key,
        level: c.level,
        parent_key: c.parentKey,
        name_ko: c.nameKo,
        nameplate_schema: JSON.stringify(c.nameplateSchema),
        safety_event_codes: [...c.safetyEventCodes],
      })),
    )
    .onConflict((oc) =>
      oc.column('key').doUpdateSet((eb) => ({
        level: eb.ref('excluded.level'),
        parent_key: eb.ref('excluded.parent_key'),
        name_ko: eb.ref('excluded.name_ko'),
        nameplate_schema: eb.ref('excluded.nameplate_schema'),
        safety_event_codes: eb.ref('excluded.safety_event_codes'),
      })),
    )
    .execute();
}

async function upsertMetricDefs(trx: Trx): Promise<void> {
  await trx
    .insertInto('om.metric_def')
    .values(
      METRIC_DEFS.map((m) => ({
        key: m.key,
        quantity: m.quantity,
        unit: m.unit,
        value_kind: m.valueKind,
        rollup: m.rollup,
        hard_min: m.hardMin,
        hard_max: m.hardMax,
        expected_min: m.expectedMin,
        expected_max: m.expectedMax,
        flatline_max_s: m.flatlineMaxS,
        name_ko: m.nameKo,
        aliases: JSON.stringify(m.aliases), // pg는 JS 배열을 PG 배열 리터럴로 보내므로 jsonb에는 문자열로 넣는다
      })),
    )
    .onConflict((oc) =>
      oc.column('key').doUpdateSet((eb) => ({
        quantity: eb.ref('excluded.quantity'),
        unit: eb.ref('excluded.unit'),
        value_kind: eb.ref('excluded.value_kind'),
        rollup: eb.ref('excluded.rollup'),
        hard_min: eb.ref('excluded.hard_min'),
        hard_max: eb.ref('excluded.hard_max'),
        expected_min: eb.ref('excluded.expected_min'),
        expected_max: eb.ref('excluded.expected_max'),
        flatline_max_s: eb.ref('excluded.flatline_max_s'),
        name_ko: eb.ref('excluded.name_ko'),
        aliases: eb.ref('excluded.aliases'),
      })),
    )
    .execute();
}

// site·gateway id는 smallint identity라 ON CONFLICT upsert를 반복하면 시퀀스 값이 소모된다.
// 그래서 코드로 먼저 UPDATE하고, 없을 때만 INSERT한다.
async function upsertSite(trx: Trx, site: SiteDef): Promise<number> {
  const values = {
    name: site.name,
    lat: site.lat,
    lon: site.lon,
    timezone: site.timezone,
    attributes: JSON.stringify(site.attributes),
  };
  const updated = await trx.updateTable('om.site').set(values).where('code', '=', site.code).returning('id').executeTakeFirst();
  if (updated) return updated.id;

  const inserted = await trx.insertInto('om.site').values({ code: site.code, ...values }).returning('id').executeTakeFirstOrThrow();
  return inserted.id;
}

async function upsertGateway(trx: Trx, siteId: number, gateway: GatewayDef): Promise<number> {
  // status·last_seen_at 등 운영 필드는 덮어쓰지 않는다.
  const updated = await trx
    .updateTable('om.gateway')
    .set({ site_id: siteId })
    .where('code', '=', gateway.code)
    .returning('id')
    .executeTakeFirst();
  if (updated) return updated.id;

  const inserted = await trx
    .insertInto('om.gateway')
    .values({ site_id: siteId, code: gateway.code })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

async function upsertGatewayKey(trx: Trx, gatewayId: number, gateway: GatewayDef, options: SeedOptions): Promise<void> {
  const secret = options.gatewaySecrets.get(gateway.code);
  if (!secret) throw new Error(`${gateway.code}의 개발용 비밀값(${gateway.secretEnvVar})이 없습니다`);

  // 매번 현재 INGEST_KEY_ENC_KEY로 다시 암호화한다 (키를 바꿨어도 시드를 다시 돌리면 맞춰진다).
  // revoked_at은 건드리지 않는다.
  await trx
    .insertInto('om.gateway_key')
    .values({
      key_id: gateway.keyId,
      gateway_id: gatewayId,
      secret_enc: encryptGatewaySecret(secret, options.encryptionKey, gateway.keyId),
    })
    .onConflict((oc) =>
      oc.column('key_id').doUpdateSet((eb) => ({
        gateway_id: eb.ref('excluded.gateway_id'),
        secret_enc: eb.ref('excluded.secret_enc'),
      })),
    )
    .execute();
}

const depthOf = (asset: AssetDef) => asset.code.split('/').length;
const parentCodeOf = (code: string) => (code.includes('/') ? code.slice(0, code.lastIndexOf('/')) : null);

/** 깊이별로 한 번에 upsert한다 (부모 id가 먼저 있어야 자식의 parent_id를 채울 수 있다). 코드 → id */
async function upsertAssets(trx: Trx, siteId: number, site: SiteDef): Promise<ReadonlyMap<string, number>> {
  const ids = new Map<string, number>();
  const depths = [...new Set(site.assets.map(depthOf))].sort((a, b) => a - b);

  for (const depth of depths) {
    const rows = site.assets
      .filter((asset) => depthOf(asset) === depth)
      .map((asset) => {
        const parentCode = parentCodeOf(asset.code);
        const parentId = parentCode === null ? null : ids.get(parentCode);
        if (parentId === undefined) throw new Error(`${site.code}/${asset.code}의 부모 설비(${parentCode})가 정의돼 있지 않습니다`);
        return {
          site_id: siteId,
          parent_id: parentId,
          level: asset.level,
          class_key: asset.classKey,
          code: asset.code,
          path: `${site.code}/${asset.code}`,
          name: asset.name,
          nameplate: JSON.stringify(asset.nameplate),
          peer_group: asset.peerGroup,
          criticality: asset.criticality,
          commissioned_at: asset.commissionedAt,
        };
      });

    const upserted = await trx
      .insertInto('om.asset')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['site_id', 'code']).doUpdateSet((eb) => ({
          parent_id: eb.ref('excluded.parent_id'),
          level: eb.ref('excluded.level'),
          class_key: eb.ref('excluded.class_key'),
          path: eb.ref('excluded.path'),
          name: eb.ref('excluded.name'),
          nameplate: eb.ref('excluded.nameplate'),
          peer_group: eb.ref('excluded.peer_group'),
          criticality: eb.ref('excluded.criticality'),
          commissioned_at: eb.ref('excluded.commissioned_at'),
        })),
      )
      .returning(['id', 'code'])
      .execute();
    for (const { id, code } of upserted) ids.set(code, id);
  }
  return ids;
}

async function upsertPoints(trx: Trx, gatewayId: number, assetIds: ReadonlyMap<string, number>, site: SiteDef): Promise<number> {
  const rows = site.assets.flatMap((asset) => {
    const assetId = assetIds.get(asset.code);
    if (assetId === undefined) throw new Error(`${site.code}/${asset.code} 설비 id를 찾지 못했습니다`);
    return asset.points.map((point) => ({
      asset_id: assetId,
      metric_key: point.metricKey,
      qualifier: point.qualifier,
      gateway_id: gatewayId,
      source_key: point.sourceKey,
      source_unit: point.sourceUnit,
      scale: point.scale,
      value_offset: point.valueOffset,
      period_s: point.periodS,
    }));
  });
  if (rows.length === 0) return 0;

  await trx
    .insertInto('om.point')
    .values(rows)
    .onConflict((oc) =>
      oc.columns(['asset_id', 'metric_key', 'qualifier']).doUpdateSet((eb) => ({
        gateway_id: eb.ref('excluded.gateway_id'),
        source_key: eb.ref('excluded.source_key'),
        source_unit: eb.ref('excluded.source_unit'),
        scale: eb.ref('excluded.scale'),
        value_offset: eb.ref('excluded.value_offset'),
        period_s: eb.ref('excluded.period_s'),
      })),
    )
    .execute();
  return rows.length;
}

/**
 * 카탈로그 → 사이트 → 설비 → 게이트웨이·키 → 포인트 순으로 한 트랜잭션에서 upsert한다.
 * 정의에서 빠진 행을 지우지는 않는다 (측정값이 그 행을 참조할 수 있다).
 */
export async function seedDatabase(db: Kysely<DB>, options: SeedOptions): Promise<SeedSummary> {
  return db.transaction().execute(async (trx) => {
    await upsertAssetClasses(trx);
    await upsertMetricDefs(trx);

    let assets = 0;
    let points = 0;
    for (const site of SIM_SITES) {
      const siteId = await upsertSite(trx, site);
      const assetIds = await upsertAssets(trx, siteId, site);
      const gatewayId = await upsertGateway(trx, siteId, site.gateway);
      await upsertGatewayKey(trx, gatewayId, site.gateway, options);
      assets += assetIds.size;
      points += await upsertPoints(trx, gatewayId, assetIds, site);
    }

    return {
      assetClasses: ASSET_CLASSES.length,
      metricDefs: METRIC_DEFS.length,
      sites: SIM_SITES.length,
      assets,
      gateways: SIM_SITES.length,
      points,
    };
  });
}
