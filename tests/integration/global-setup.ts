import { migrate } from '../support/migrate';
import { assertDbServerUp, assertTestDatabaseUrl, readTestEnvFile } from '../support/test-env';

/** 테스트 DB를 최신 마이그레이션까지 올린다 (npm run db:migrate:test와 같은 동작). */
export async function setup(): Promise<void> {
  await assertDbServerUp();
  const databaseUrl = assertTestDatabaseUrl(readTestEnvFile().DATABASE_URL);
  await migrate(databaseUrl, 'up');
}
