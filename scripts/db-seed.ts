// 카탈로그(asset_class·metric_def)와 사이트(가상 SIM-A/B/C + 실사이트 GP-1)를 멱등 upsert한다.
//   npm run db:seed       → .env.development.local (hysol)
//   npm run db:seed:test  → .env.test.local (hysol_test)
// 게이트웨이 개발용 HMAC 비밀값(SIM_GATEWAY_SECRET_<CODE>)이 env 파일에 없으면 생성해 파일 끝에 추가하고,
// DB에는 INGEST_KEY_ENC_KEY로 암호화해 om.gateway_key에 저장한다. 비밀값은 출력하지 않는다.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { SEED_SITES } from '../db/seed/sites';
import { db } from '../lib/db/kysely';
import { seedDatabase } from '../lib/db/seed';
import { getServerEnv } from '../lib/env';
import { decodeEncryptionKey } from '../lib/ingest/key-crypto';

// 운영 접속정보가 있는 .env.local 등 다른 파일에는 절대 쓰지 않는다.
const ALLOWED_ENV_FILES = ['.env.development.local', '.env.test.local'] as const;
const MIN_SECRET_LENGTH = 32;

function readEnvFileArg(): string {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } });
  const envFile = values['env-file'];
  if (!envFile || !ALLOWED_ENV_FILES.some((allowed) => allowed === envFile)) {
    throw new Error(`--env-file은 ${ALLOWED_ENV_FILES.join(' 또는 ')}이어야 합니다 (받은 값: ${envFile ?? '없음'})`);
  }
  return resolve(process.cwd(), envFile); // npm 스크립트는 저장소 루트에서 실행된다
}

/** 셸에 남은 DATABASE_URL이 파일 값을 가리는 경우(dotenv는 기존 값을 덮어쓰지 않음) 엉뚱한 DB에 넣지 않도록 막는다. */
function assertDatabaseUrlFromFile(envFilePath: string, databaseUrl: string): void {
  const fromFile = parseEnv(readFileSync(envFilePath, 'utf8')).DATABASE_URL;
  if (fromFile !== databaseUrl) {
    throw new Error(`현재 DATABASE_URL이 ${envFilePath}의 값과 다릅니다. 셸의 DATABASE_URL을 지우고 다시 실행하세요.`);
  }
}

/** 게이트웨이 코드 → 비밀값. 없는 값은 생성해 env 파일 끝에 추가한다. */
function ensureGatewaySecrets(envFilePath: string): ReadonlyMap<string, string> {
  const secrets = new Map<string, string>();
  const newLines: string[] = [];

  for (const { gateway } of SEED_SITES) {
    const existing = process.env[gateway.secretEnvVar];
    if (existing) {
      if (existing.length < MIN_SECRET_LENGTH) {
        throw new Error(`${gateway.secretEnvVar}는 ${MIN_SECRET_LENGTH}자 이상이어야 합니다. 값을 지우면 새로 생성합니다.`);
      }
      secrets.set(gateway.code, existing);
      continue;
    }
    const generated = randomBytes(32).toString('base64url');
    secrets.set(gateway.code, generated);
    newLines.push(`${gateway.secretEnvVar}=${generated}`);
  }

  if (newLines.length > 0) {
    const content = readFileSync(envFilePath, 'utf8');
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    const header = '# 시뮬레이터 게이트웨이 개발용 HMAC 비밀값 (npm run db:seed가 생성)';
    appendFileSync(envFilePath, `${separator}${header}\n${newLines.join('\n')}\n`, 'utf8');
    const names = newLines.map((line) => line.slice(0, line.indexOf('=')));
    console.log(`[seed] 비밀값 ${names.length}개를 생성해 ${envFilePath}에 추가했습니다: ${names.join(', ')}`);
  }
  return secrets;
}

async function main(): Promise<void> {
  const envFilePath = readEnvFileArg();
  if (!existsSync(envFilePath)) throw new Error(`${envFilePath}이 없습니다. README의 "로컬 개발" 절을 참고하세요.`);

  const env = getServerEnv(); // DATABASE_URL·INGEST_KEY_ENC_KEY 검증
  assertDatabaseUrlFromFile(envFilePath, env.DATABASE_URL);
  const encryptionKey = decodeEncryptionKey(env.INGEST_KEY_ENC_KEY);
  const gatewaySecrets = ensureGatewaySecrets(envFilePath);

  try {
    const summary = await seedDatabase(db, { encryptionKey, gatewaySecrets });
    const database = new URL(env.DATABASE_URL).pathname.slice(1);
    console.log(
      `[seed] ${database} 완료: 설비 종류 ${summary.assetClasses}, 메트릭 ${summary.metricDefs}, ` +
        `사이트 ${summary.sites}, 설비 ${summary.assets}, 게이트웨이 ${summary.gateways}, 포인트 ${summary.points}`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
