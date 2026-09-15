import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertDbServerUp, assertTestDatabaseUrl, readTestEnvFile } from '../support/test-env';
import { LOOP_FIXTURE } from './closed-loop-plan';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_NAME, E2E_BASE_URL, getE2eAdminPassword } from './e2e-env';
import { loadMemoryFixture } from './memory-fixture';
import { P3_FIXTURE } from './p3-chain-plan';
import { ingestSimulatedSite } from './sim-ingest';
import { resetTestDatabase, simGatewaySecrets } from './test-db';

/** npm run admin:create:test와 같은 스크립트를 셸 없이 실행한다 (비밀번호가 셸에서 해석되지 않도록). */
function createAdmin(env: Readonly<Record<string, string>>, password: string): void {
  const tsxCli = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const args = ['--email', E2E_ADMIN_EMAIL, '--password', password, '--name', E2E_ADMIN_NAME];
  execFileSync(process.execPath, [tsxCli, 'scripts/admin-create.ts', ...args], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

/**
 * webServer(프로덕션 빌드, 3100) 기동 후, 테스트 전에 한 번 실행된다.
 * 테스트 DB 초기화(마이그레이션 down → up) → 시드 → 테스트 관리자 생성 → 시뮬레이터 데이터를 실제 수집 API로 적재
 * → 고정 과거 기간을 원시에 직접 적재: 폐루프 시나리오용 SIM-A 고장 주입 80일, P3 수소 체인 시나리오용 SIM-B 누설·압축기 21일.
 * 이전 실행이 남긴 매핑·안전 확인·계정·rate limit 기록을 지워 매번 같은 상태에서 시작한다.
 */
export default async function globalSetup(): Promise<void> {
  await assertDbServerUp();
  const env = readTestEnvFile();
  const databaseUrl = assertTestDatabaseUrl(env.DATABASE_URL);
  const password = getE2eAdminPassword();
  const secrets = simGatewaySecrets(env);

  await resetTestDatabase(databaseUrl, env, secrets);
  createAdmin(env, password);
  await ingestSimulatedSite(E2E_BASE_URL, secrets);
  await loadMemoryFixture(databaseUrl, LOOP_FIXTURE);
  await loadMemoryFixture(databaseUrl, P3_FIXTURE);
}
