import 'server-only';
import { db } from '@/lib/db/kysely';

export interface GatewayKeyRow {
  readonly keyId: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
}

export interface GatewayWithKeys {
  readonly id: number;
  readonly code: string;
  readonly siteCode: string;
  readonly status: string;
  readonly lastSeenMs: number | null;
  /** 활성 키 먼저, 그다음 최근 생성 순 */
  readonly keys: readonly GatewayKeyRow[];
}

/** 설정 화면용: 게이트웨이와 키 목록 (비밀값·암호문은 읽지 않는다) */
export async function listGatewaysWithKeys(): Promise<readonly GatewayWithKeys[]> {
  const [gateways, keys] = await Promise.all([
    db
      .selectFrom('om.gateway as g')
      .innerJoin('om.site as s', 's.id', 'g.site_id')
      .select(['g.id', 'g.code', 's.code as site_code', 'g.status', 'g.last_seen_at'])
      .orderBy('s.code')
      .orderBy('g.code')
      .execute(),
    db.selectFrom('om.gateway_key').select(['key_id', 'gateway_id', 'created_at', 'revoked_at']).orderBy('created_at', 'desc').execute(),
  ]);

  return gateways.map((gateway) => ({
    id: gateway.id,
    code: gateway.code,
    siteCode: gateway.site_code,
    status: gateway.status,
    lastSeenMs: gateway.last_seen_at ? gateway.last_seen_at.getTime() : null,
    keys: keys
      .filter((key) => key.gateway_id === gateway.id)
      .map((key) => ({ keyId: key.key_id, createdAtMs: key.created_at.getTime(), revokedAtMs: key.revoked_at ? key.revoked_at.getTime() : null }))
      .sort((a, b) => Number(a.revokedAtMs !== null) - Number(b.revokedAtMs !== null)),
  }));
}

export async function listSiteOptions(): Promise<readonly Readonly<{ id: number; code: string; name: string }>[]> {
  return db.selectFrom('om.site').select(['id', 'code', 'name']).orderBy('code').execute();
}
