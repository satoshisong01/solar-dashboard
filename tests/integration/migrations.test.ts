import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../support/migrate';
import { assertTestDatabaseUrl } from '../support/test-env';

const databaseUrl = assertTestDatabaseUrl(process.env.DATABASE_URL);

const AUTH_TABLES = ['auth_account', 'auth_rate_limit', 'auth_session', 'auth_user', 'auth_verification'];
const MIGRATION_NAMES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => basename(file, '.sql'))
  .sort();

describe('마이그레이션 (hysol_test)', () => {
  const client = new pg.Client({ connectionString: databaseUrl });

  beforeAll(() => client.connect());
  afterAll(() => client.end());

  async function hasOmSchema(): Promise<boolean> {
    const { rowCount } = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'om'");
    return rowCount === 1;
  }

  async function authTables(): Promise<string[]> {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'auth\\_%'
       ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  }

  it('최신 상태에서 om 스키마와 auth_* 테이블이 있다', async () => {
    expect(await hasOmSchema()).toBe(true);
    expect(await authTables()).toEqual(AUTH_TABLES);
  });

  it('전부 down → up 왕복이 오류 없이 끝나고 같은 상태로 돌아온다', async () => {
    const reverted = await migrate(databaseUrl, 'down');
    expect(reverted).toEqual(MIGRATION_NAMES.toReversed());
    expect(await hasOmSchema()).toBe(false);
    expect(await authTables()).toEqual([]);

    const applied = await migrate(databaseUrl, 'up');
    expect(applied).toEqual(MIGRATION_NAMES);
    expect(await hasOmSchema()).toBe(true);
    expect(await authTables()).toEqual(AUTH_TABLES);
  });

  it('이미 최신이면 up을 다시 실행해도 적용할 것이 없다', async () => {
    expect(await migrate(databaseUrl, 'up')).toEqual([]);
  });
});
