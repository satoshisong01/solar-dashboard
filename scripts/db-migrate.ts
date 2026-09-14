// DB 마이그레이션 (node-pg-migrate 프로그램 API). 연결은 앱과 같은 규칙으로 DATABASE_URL·DATABASE_SSL·DATABASE_SSL_CA_PATH를 읽는다
// (verify-full이면 CA 번들로 인증서·호스트를 검증). 인증·수집 비밀값은 필요 없다.
//   npm run db:migrate        → .env.development.local, 남은 마이그레이션 전부 적용
//   npm run db:migrate:down   → .env.development.local, 마지막 1개 되돌리기
//   npm run db:migrate:test   → .env.test.local
//   npx dotenv -e <env 파일> -- tsx scripts/db-migrate.ts up|down [개수]   → 운영 RDS 등 (README "운영 RDS에 마이그레이션 적용")
import { parseArgs } from 'node:util';
import { runMigrations, type MigrationDirection } from '../lib/db/migrate';
import { buildSslOptions } from '../lib/db/pool';
import { parseDatabaseEnv } from '../lib/env';

const USAGE = '사용법: tsx scripts/db-migrate.ts up|down [개수]  (up 기본 전부, down 기본 1개)';

interface MigrateArgs {
  readonly direction: MigrationDirection;
  readonly count: number;
}

function readArgs(): MigrateArgs {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const [direction, rawCount, ...rest] = positionals;
  if ((direction !== 'up' && direction !== 'down') || rest.length > 0) throw new Error(USAGE);
  if (rawCount === undefined) return { direction, count: direction === 'up' ? Infinity : 1 };

  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`개수는 1 이상의 정수여야 합니다 (받은 값: ${rawCount}). ${USAGE}`);
  return { direction, count };
}

/** 비밀번호를 빼고 접속 대상만 보여 준다 */
function describeTarget(databaseUrl: string, ssl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname} (SSL ${ssl})`;
}

async function main(): Promise<void> {
  const { direction, count } = readArgs();
  const env = parseDatabaseEnv();
  const connection = { connectionString: env.DATABASE_URL, ssl: buildSslOptions(env) };
  console.log(`[migrate] ${describeTarget(env.DATABASE_URL, env.DATABASE_SSL)} · ${direction} ${count === Infinity ? '전부' : `${count}개`}`);

  const ran = await runMigrations({ connection, direction, count, log: (message) => console.log(`[migrate] ${message}`) });
  console.log(ran.length === 0 ? '[migrate] 실행할 마이그레이션이 없습니다 (이미 최신)' : `[migrate] 완료: ${ran.length}개 (${ran.join(', ')})`);
}

main().catch((error: unknown) => {
  console.error('[migrate] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
