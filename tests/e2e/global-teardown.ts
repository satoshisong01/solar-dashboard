import { LOCAL_PG, isPortOpen } from '../../scripts/local-pg';
import { assertTestDatabaseUrl, readTestEnvFile } from '../support/test-env';
import { resetTestDatabase, simGatewaySecrets } from './test-db';

/**
 * 모든 테스트가 끝난 뒤(webServer 종료 전) 테스트 DB를 "db:migrate:test + db:seed:test" 상태로 되돌린다.
 * E2E가 만든 수집 데이터·포인트·게이트웨이·계정이 integration 테스트(시드 행 수 검사 등)에 섞이지 않게 하기 위해서다.
 * globalSetup이 DB가 꺼져 있어 실패한 경우에도 불리므로, 그때는 아무것도 하지 않는다.
 */
export default async function globalTeardown(): Promise<void> {
  if (!(await isPortOpen(LOCAL_PG.port, LOCAL_PG.host))) return;
  const env = readTestEnvFile();
  const summary = await resetTestDatabase(assertTestDatabaseUrl(env.DATABASE_URL), env, simGatewaySecrets(env));
  console.log(`[e2e] 테스트 DB 초기화: 사이트 ${summary.sites} · 설비 ${summary.assets} · 포인트 ${summary.points}`);
}
