// E2E globalSetup·globalTeardown 공용: 테스트 DB를 "마이그레이션 + 시드" 상태로 되돌린다.
// E2E는 매핑·안전 확인·게이트웨이·관리자 계정처럼 되돌릴 수 없는 변경을 남기므로, 매 실행 전후로 초기화해야
// 같은 시나리오를 다시 돌릴 수 있고 integration 테스트(시드 행 수 검사 등)도 영향을 받지 않는다.
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { SEED_SITES } from '../../db/seed/sites';
import { seedDatabase, type SeedSummary } from '../../lib/db/seed';
import type { DB } from '../../lib/db/types';
import { decodeEncryptionKey } from '../../lib/ingest/key-crypto';
import { migrate } from '../support/migrate';
import { TEST_ENV_FILE } from '../support/test-env';

type TestEnv = Readonly<Record<string, string>>;

/** 게이트웨이 코드 → HMAC 비밀값. db:seed:test가 env 파일에 넣은 값이 있으면 그대로 쓰고, 없으면 이번 실행용으로 만든다. */
export function simGatewaySecrets(env: TestEnv): ReadonlyMap<string, string> {
  return new Map(SEED_SITES.map(({ gateway }) => [gateway.code, env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
}

function encryptionKeyOf(env: TestEnv): Uint8Array {
  const base64Key = env.INGEST_KEY_ENC_KEY;
  if (!base64Key) throw new Error(`${TEST_ENV_FILE}에 INGEST_KEY_ENC_KEY를 넣으세요 (.env.example 참고).`);
  return decodeEncryptionKey(base64Key);
}

/**
 * 모든 마이그레이션을 되돌렸다가 다시 올리고(수집·계정·rate limit 행까지 비움) 카탈로그·가상 사이트를 시드한다.
 * 호출 전에 assertTestDatabaseUrl로 로컬 hysol_test인지 확인해야 한다.
 */
export async function resetTestDatabase(databaseUrl: string, env: TestEnv, gatewaySecrets: ReadonlyMap<string, string>): Promise<SeedSummary> {
  const encryptionKey = encryptionKeyOf(env);
  await migrate(databaseUrl, 'down');
  await migrate(databaseUrl, 'up');

  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }) }) });
  try {
    return await seedDatabase(db, { encryptionKey, gatewaySecrets });
  } finally {
    await db.destroy();
  }
}
