// [로컬 전용] DATABASE_URL이 가리키는 로컬 DB의 모든 사용자 스키마를 지운다 (npm run db:reset).
// 이후 npm 스크립트가 db:migrate를 이어서 실행한다.
// 안전장치: localhost:54320(embedded-postgres)이 아니면 아무것도 하지 않고 실패한다.
import pg from 'pg';
import { getServerEnv } from '../lib/env';
import { assertLocalDatabaseUrl, log } from './local-pg';

async function resetSchemas(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'`,
  );
  const schemas = rows.map((row) => row.nspname);

  await client.query('BEGIN');
  try {
    for (const schema of schemas) {
      await client.query(`DROP SCHEMA ${client.escapeIdentifier(schema)} CASCADE`);
    }
    // PostgreSQL 15+ 기본 public 스키마와 같은 소유자·권한으로 되돌린다.
    await client.query('CREATE SCHEMA public AUTHORIZATION pg_database_owner');
    await client.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return schemas;
}

async function main(): Promise<void> {
  const { DATABASE_URL } = getServerEnv();
  const url = assertLocalDatabaseUrl(DATABASE_URL);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const dropped = await resetSchemas(client);
    log(`${url.pathname.slice(1)} 스키마 초기화 완료 (삭제: ${dropped.join(', ') || '없음'})`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[db] 초기화 실패:', error instanceof Error ? error.message : error);
  process.exit(1);
});
