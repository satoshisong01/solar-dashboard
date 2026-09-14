import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from '../support/migrate';
import { assertDbServerUp, assertTestDatabaseUrl, readTestEnvFile } from '../support/test-env';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_NAME, getE2eAdminPassword } from './e2e-env';

async function deleteUser(databaseUrl: string, email: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // 세션·계정은 FK ON DELETE CASCADE로 함께 지워진다.
    await client.query('DELETE FROM auth_user WHERE email = $1', [email]);
  } finally {
    await client.end();
  }
}

/** npm run admin:create:test와 같은 스크립트를 셸 없이 실행한다 (비밀번호가 셸에서 해석되지 않도록). */
function createAdmin(env: Readonly<Record<string, string>>, password: string): void {
  const tsxCli = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const args = ['--email', E2E_ADMIN_EMAIL, '--password', password, '--name', E2E_ADMIN_NAME];
  execFileSync(process.execPath, [tsxCli, 'scripts/admin-create.ts', ...args], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

/** 테스트 DB를 최신으로 올리고 테스트 관리자를 새로 만든다. webServer 기동 후, 테스트 전에 한 번 실행된다. */
export default async function globalSetup(): Promise<void> {
  await assertDbServerUp();
  const env = readTestEnvFile();
  const databaseUrl = assertTestDatabaseUrl(env.DATABASE_URL);
  const password = getE2eAdminPassword();

  await migrate(databaseUrl, 'up');
  // 비밀번호를 바꿨어도 로그인되도록 기존 계정을 지우고 다시 만든다.
  await deleteUser(databaseUrl, E2E_ADMIN_EMAIL);
  createAdmin(env, password);
}
