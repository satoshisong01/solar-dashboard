// 게이트웨이 생성과 HMAC 키 발급 (설계 §5.2 gateway·gateway_key, 활성 키 최대 2개로 회전). 폐기는 lib/ingest/keys.ts의 revokeGatewayKey.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { issueGatewayKey, type IssuedGatewayKey } from '@/lib/ingest/keys';
import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from './pg-errors';

/** DB 트리거(om.gateway_key_limit_active)와 같은 값 */
export const MAX_ACTIVE_GATEWAY_KEYS = 2;

export type CreateGatewayResult =
  | Readonly<{ kind: 'created'; gatewayId: number }>
  | Readonly<{ kind: 'site_missing' | 'duplicate_code' }>;

export async function createGateway(db: Kysely<DB>, input: Readonly<{ siteId: number; code: string }>): Promise<CreateGatewayResult> {
  const site = await db.selectFrom('om.site').select('id').where('id', '=', input.siteId).executeTakeFirst();
  if (!site) return { kind: 'site_missing' };
  try {
    const row = await db.insertInto('om.gateway').values({ site_id: input.siteId, code: input.code }).returning('id').executeTakeFirstOrThrow();
    return { kind: 'created', gatewayId: row.id };
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return { kind: 'duplicate_code' };
    throw error;
  }
}

export type IssueKeyResult =
  | Readonly<{ kind: 'issued'; key: IssuedGatewayKey; gatewayCode: string }>
  | Readonly<{ kind: 'gateway_missing' | 'limit_reached' }>;

/** 새 키를 발급한다. 비밀값은 결과로 한 번만 돌려주고 DB에는 암호문만 남는다 */
export async function issueKeyForGateway(db: Kysely<DB>, gatewayId: number, encryptionKey: Uint8Array): Promise<IssueKeyResult> {
  const gateway = await db
    .selectFrom('om.gateway as g')
    .select((eb) => [
      'g.code',
      eb.selectFrom('om.gateway_key as k').select(sql<number>`count(*)::int`.as('n')).whereRef('k.gateway_id', '=', 'g.id').where('k.revoked_at', 'is', null).as('active'),
    ])
    .where('g.id', '=', gatewayId)
    .executeTakeFirst();
  if (!gateway) return { kind: 'gateway_missing' };
  if ((gateway.active ?? 0) >= MAX_ACTIVE_GATEWAY_KEYS) return { kind: 'limit_reached' };

  try {
    const key = await issueGatewayKey(db, { gatewayId, encryptionKey });
    return { kind: 'issued', key, gatewayCode: gateway.code };
  } catch (error) {
    // 동시에 발급하면 사전 확인을 지나도 트리거가 막는다.
    if (pgErrorCode(error) === PG_CHECK_VIOLATION) return { kind: 'limit_reached' };
    throw error;
  }
}
