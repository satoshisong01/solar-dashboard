// integration·e2e 공용: 테스트 환경변수와 로컬 테스트 DB 확인.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { LOCAL_PG, isPortOpen } from '../../scripts/local-pg';

export const TEST_ENV_FILE = '.env.test.local';
const TEST_DATABASE = 'hysol_test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * .env.test.local만 파싱한다 (process.env는 건드리지 않음). 파일이 없으면 빈 객체.
 * 다른 .env 파일, 특히 운영 접속정보가 있는 .env.local은 읽지 않는다.
 */
export function readTestEnvFile(): Readonly<Record<string, string>> {
  const file = resolve(process.cwd(), TEST_ENV_FILE); // npm 스크립트는 저장소 루트에서 실행된다
  if (!existsSync(file)) return {};

  const entries = Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.freeze(Object.fromEntries(entries));
}

/** 테스트는 마이그레이션을 되돌리고 계정을 지우므로, 로컬 hysol_test가 아니면 중단한다. */
export function assertTestDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error(`${TEST_ENV_FILE}에 DATABASE_URL이 없습니다. README의 "로컬 개발" 절을 참고해 파일을 만드세요.`);
  }

  const url = new URL(databaseUrl);
  const isLocal = LOCAL_HOSTS.has(url.hostname) && url.port === String(LOCAL_PG.port);
  if (!isLocal || url.pathname !== `/${TEST_DATABASE}`) {
    throw new Error(
      `테스트는 localhost:${LOCAL_PG.port}/${TEST_DATABASE}에서만 실행합니다. 현재: ${url.hostname}:${url.port || '5432'}${url.pathname}`,
    );
  }
  return databaseUrl;
}

/** 테스트가 서버를 몰래 띄우지 않는다. 꺼져 있으면 안내와 함께 실패한다. */
export async function assertDbServerUp(): Promise<void> {
  if (await isPortOpen(LOCAL_PG.port, LOCAL_PG.host)) return;
  throw new Error(
    `로컬 PostgreSQL(${LOCAL_PG.host}:${LOCAL_PG.port})에 연결할 수 없습니다. 먼저 npm run db:up 을 실행하세요.`,
  );
}
