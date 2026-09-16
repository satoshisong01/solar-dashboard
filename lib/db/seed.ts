// 카탈로그·사이트 시드를 DB에 멱등 upsert한다 (npm run db:seed / db:seed:test).
// 데이터 정의는 db/seed/*의 순수 모듈이고, 이 파일은 DB 쓰기만 담당한다.
// 'server-only'를 넣지 않는다: tsx 스크립트와 integration 테스트에서 import한다.
import { sql, type Kysely, type Transaction } from 'kysely';
import { ASSET_CLASSES, METRIC_DEFS } from '@/db/seed/catalog';
import { SEED_SITES } from '@/db/seed/sites';
import type { AssetDef, GatewayDef, SiteDef } from '@/db/seed/types';
import { decryptGatewaySecret, encryptGatewaySecret } from '@/lib/ingest/key-crypto';
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

/** 저장된 암호문이 현재 키로 복호화되고 비밀값이 같으면 true */
function storesSecret(secretEnc: Uint8Array, secret: string, encryptionKey: Uint8Array, keyId: string): boolean {
  try {
    return decryptGatewaySecret(secretEnc, encryptionKey, keyId) === secret;
  } catch {
    return false;
  }
}

async function upsertGatewayKey(trx: Trx, gatewayId: number, gateway: GatewayDef, options: SeedOptions): Promise<void> {
  const secret = options.gatewaySecrets.get(gateway.code);
  if (!secret) throw new Error(`${gateway.code}의 개발용 비밀값(${gateway.secretEnvVar})이 없습니다`);

  const existing = await trx.selectFrom('om.gateway_key').select(['gateway_id', 'secret_enc']).where('key_id', '=', gateway.keyId).executeTakeFirst();
  if (!existing) {
    await trx
      .insertInto('om.gateway_key')
      .values({ key_id: gateway.keyId, gateway_id: gatewayId, secret_enc: encryptGatewaySecret(secret, options.encryptionKey, gateway.keyId) })
      .execute();
    return;
  }

  // 이미 있으면 암호문을 그대로 둔다. 현재 INGEST_KEY_ENC_KEY로 복호화되지 않거나(키 교체) 비밀값이 바뀐 경우에만 다시 암호화한다.
  // revoked_at은 건드리지 않는다.
  const reencrypt = !storesSecret(existing.secret_enc, secret, options.encryptionKey, gateway.keyId);
  if (existing.gateway_id === gatewayId && !reencrypt) return;
  await trx
    .updateTable('om.gateway_key')
    .set({ gateway_id: gatewayId, ...(reencrypt ? { secret_enc: encryptGatewaySecret(secret, options.encryptionKey, gateway.keyId) } : {}) })
    .where('key_id', '=', gateway.keyId)
    .execute();
}

const depthOf = (asset: AssetDef) => asset.code.split('/').length;
const parentCodeOf = (code: string) => (code.includes('/') ? code.slice(0, code.lastIndexOf('/')) : null);

// om.asset·om.point id는 identity라 INSERT … ON CONFLICT를 반복하면 충돌한 행도 시퀀스 값을 소모한다.
// 그래서 이미 있는 행은 한 문장으로 UPDATE(값이 달라진 행만)하고, 없는 행만 INSERT한다.

interface AssetRow {
  readonly site_id: number;
  readonly parent_id: number | null;
  readonly level: AssetDef['level'];
  readonly class_key: string;
  readonly code: string;
  readonly path: string;
  readonly name: string;
  readonly nameplate: AssetDef['nameplate'];
  readonly peer_group: string | null;
  readonly criticality: number;
  readonly commissioned_at: string | null;
}

/** 정의된 행 중 DB에 이미 있는 행(id를 붙여서)과 없는 행으로 나눈다 */
function splitByExisting<T>(rows: readonly T[], idOf: (row: T) => number | undefined) {
  const existing = rows.flatMap((row) => {
    const id = idOf(row);
    return id === undefined ? [] : [{ ...row, id }];
  });
  return { existing, missing: rows.filter((row) => idOf(row) === undefined) };
}

async function updateAssets(trx: Trx, rows: readonly (AssetRow & { readonly id: number })[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    UPDATE om.asset AS a SET
      parent_id = v.parent_id, level = v.level, class_key = v.class_key, path = v.path, name = v.name,
      nameplate = v.nameplate, peer_group = v.peer_group, criticality = v.criticality, commissioned_at = v.commissioned_at
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(
      id int, parent_id int, level text, class_key text, path text, name text,
      nameplate jsonb, peer_group text, criticality smallint, commissioned_at date
    )
    WHERE a.id = v.id
      AND (a.parent_id, a.level, a.class_key, a.path, a.name, a.nameplate, a.peer_group, a.criticality, a.commissioned_at)
        IS DISTINCT FROM (v.parent_id, v.level, v.class_key, v.path, v.name, v.nameplate, v.peer_group, v.criticality, v.commissioned_at)
  `.execute(trx);
}

function assetRow(site: SiteDef, siteId: number, asset: AssetDef, ids: ReadonlyMap<string, number>): AssetRow {
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
    nameplate: asset.nameplate,
    peer_group: asset.peerGroup,
    criticality: asset.criticality,
    commissioned_at: asset.commissionedAt,
  };
}

/** 깊이별로 처리한다 (부모 id가 먼저 있어야 자식의 parent_id를 채울 수 있다). 코드 → id */
async function upsertAssets(trx: Trx, siteId: number, site: SiteDef): Promise<ReadonlyMap<string, number>> {
  const stored = await trx.selectFrom('om.asset').select(['id', 'code']).where('site_id', '=', siteId).execute();
  const ids = new Map(stored.map((row) => [row.code, row.id]));
  const depths = [...new Set(site.assets.map(depthOf))].sort((a, b) => a - b);

  for (const depth of depths) {
    const rows = site.assets.filter((asset) => depthOf(asset) === depth).map((asset) => assetRow(site, siteId, asset, ids));
    const { existing, missing } = splitByExisting(rows, (row) => ids.get(row.code));
    await updateAssets(trx, existing);
    if (missing.length === 0) continue;
    const inserted = await trx
      .insertInto('om.asset')
      .values(missing.map((row) => ({ ...row, nameplate: JSON.stringify(row.nameplate) })))
      .returning(['id', 'code'])
      .execute();
    for (const { id, code } of inserted) ids.set(code, id);
  }
  return new Map(site.assets.flatMap((asset) => {
    const id = ids.get(asset.code);
    return id === undefined ? [] : [[asset.code, id] as const];
  }));
}

interface PointRow {
  readonly asset_id: number;
  readonly metric_key: string;
  readonly qualifier: string;
  readonly gateway_id: number;
  readonly source_key: string;
  readonly source_unit: string;
  readonly scale: number;
  readonly value_offset: number;
  readonly period_s: number;
  /** 도면 계장 태그 (없으면 null) */
  readonly instrument_tag: string | null;
}

const pointKey = (row: Pick<PointRow, 'asset_id' | 'metric_key' | 'qualifier'>) => `${row.asset_id}|${row.metric_key}|${row.qualifier}`;

async function updatePoints(trx: Trx, rows: readonly (PointRow & { readonly id: number })[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    UPDATE om.point AS p SET
      gateway_id = v.gateway_id, source_key = v.source_key, source_unit = v.source_unit,
      scale = v.scale, value_offset = v.value_offset, period_s = v.period_s, instrument_tag = v.instrument_tag
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(
      id int, gateway_id smallint, source_key text, source_unit text, scale float8, value_offset float8, period_s int, instrument_tag text
    )
    WHERE p.id = v.id
      AND (p.gateway_id, p.source_key, p.source_unit, p.scale, p.value_offset, p.period_s, p.instrument_tag)
        IS DISTINCT FROM (v.gateway_id, v.source_key, v.source_unit, v.scale, v.value_offset, v.period_s, v.instrument_tag)
  `.execute(trx);
}

async function upsertPoints(trx: Trx, gatewayId: number, assetIds: ReadonlyMap<string, number>, site: SiteDef): Promise<number> {
  const rows = site.assets.flatMap((asset) => {
    const assetId = assetIds.get(asset.code);
    if (assetId === undefined) throw new Error(`${site.code}/${asset.code} 설비 id를 찾지 못했습니다`);
    return asset.points.map((point): PointRow => ({
      asset_id: assetId,
      metric_key: point.metricKey,
      qualifier: point.qualifier,
      gateway_id: gatewayId,
      source_key: point.sourceKey,
      source_unit: point.sourceUnit,
      scale: point.scale,
      value_offset: point.valueOffset,
      period_s: point.periodS,
      instrument_tag: point.instrumentTag,
    }));
  });
  if (rows.length === 0) return 0;

  const stored = await trx
    .selectFrom('om.point')
    .select(['id', 'asset_id', 'metric_key', 'qualifier'])
    .where('asset_id', 'in', [...new Set(rows.map((row) => row.asset_id))])
    .execute();
  const ids = new Map(stored.map((row) => [pointKey(row), row.id]));
  const { existing, missing } = splitByExisting(rows, (row) => ids.get(pointKey(row)));
  await updatePoints(trx, existing);
  if (missing.length > 0) await trx.insertInto('om.point').values(missing).execute();
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
    for (const site of SEED_SITES) {
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
      sites: SEED_SITES.length,
      assets,
      gateways: SEED_SITES.length,
      points,
    };
  });
}
