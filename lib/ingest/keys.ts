// 게이트웨이 HMAC 키 발급·폐기·조회. 비밀값은 AES-256-GCM(INGEST_KEY_ENC_KEY)으로 암호화해 저장한다 (key-crypto.ts).
// 'server-only'를 넣지 않는다: tsx 스크립트와 테스트에서도 쓴다.
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { decryptGatewaySecret, encryptGatewaySecret } from './key-crypto';
import { KEY_ID_PATTERN } from './signature';

const SECRET_BYTES = 32;

export interface ActiveGatewayKey {
  readonly keyId: string;
  readonly gatewayId: number;
  readonly gatewayCode: string;
  readonly gatewayActive: boolean;
  readonly siteId: number;
  readonly secret: string;
}

/** 폐기되지 않은 키를 게이트웨이 정보와 함께 찾고 비밀값을 복호화한다. 없으면 null. */
export async function findActiveGatewayKey(db: Kysely<DB>, keyId: string, encryptionKey: Uint8Array): Promise<ActiveGatewayKey | null> {
  const row = await db
    .selectFrom('om.gateway_key as k')
    .innerJoin('om.gateway as g', 'g.id', 'k.gateway_id')
    .select(['k.key_id', 'k.secret_enc', 'g.id as gateway_id', 'g.code as gateway_code', 'g.status', 'g.site_id'])
    .where('k.key_id', '=', keyId)
    .where('k.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;

  return {
    keyId: row.key_id,
    gatewayId: row.gateway_id,
    gatewayCode: row.gateway_code,
    gatewayActive: row.status === 'active',
    siteId: row.site_id,
    secret: decryptGatewaySecret(row.secret_enc, encryptionKey, row.key_id),
  };
}

/** 기본 키 ID: gk_<게이트웨이 코드 소문자>_<YYYYMMDD>_<랜덤 6자> */
function defaultKeyId(gatewayCode: string, now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `gk_${gatewayCode.toLowerCase().replace(/[^a-z0-9-]/g, '-')}_${day}_${randomBytes(3).toString('hex')}`;
}

export interface IssuedGatewayKey {
  readonly keyId: string;
  /** 발급 응답에서 한 번만 돌려준다. DB에는 암호문만 남는다 */
  readonly secret: string;
}

export interface IssueGatewayKeyInput {
  readonly gatewayId: number;
  readonly encryptionKey: Uint8Array;
  readonly keyId?: string;
}

/** 새 키를 발급한다. 게이트웨이당 활성 키가 이미 2개면 DB 트리거가 거부한다 (먼저 하나를 폐기). */
export async function issueGatewayKey(db: Kysely<DB>, input: IssueGatewayKeyInput): Promise<IssuedGatewayKey> {
  const gateway = await db.selectFrom('om.gateway').select('code').where('id', '=', input.gatewayId).executeTakeFirst();
  if (!gateway) throw new Error(`게이트웨이(id=${input.gatewayId})가 없습니다`);

  const keyId = input.keyId ?? defaultKeyId(gateway.code, new Date());
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`키 ID는 영문·숫자·._:- 1~128자여야 합니다: ${keyId}`);

  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  await db
    .insertInto('om.gateway_key')
    .values({ key_id: keyId, gateway_id: input.gatewayId, secret_enc: encryptGatewaySecret(secret, input.encryptionKey, keyId) })
    .execute();
  return { keyId, secret };
}

/** 키를 폐기한다. 이미 폐기됐거나 없으면 false. */
export async function revokeGatewayKey(db: Kysely<DB>, keyId: string, now: Date = new Date()): Promise<boolean> {
  const result = await db
    .updateTable('om.gateway_key')
    .set({ revoked_at: now })
    .where('key_id', '=', keyId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows > BigInt(0);
}
