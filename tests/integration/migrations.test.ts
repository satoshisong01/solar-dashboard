import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '../../lib/db/migrate';
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

  async function tablesIn(schema: string, pattern = '%'): Promise<string[]> {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE $2
       ORDER BY table_name`,
      [schema, pattern],
    );
    return rows.map((row) => row.table_name);
  }

  it('최신 상태에서 om 스키마와 auth_* 테이블이 있다', async () => {
    expect(await hasOmSchema()).toBe(true);
    expect(await tablesIn('om', 'auth\_%')).toEqual(AUTH_TABLES);
  });

  // 운영 DB는 여러 프로젝트가 public 스키마를 공유한다. 우리 마이그레이션은 public에 아무것도 만들면 안 된다.
  it('public 스키마에는 테이블을 하나도 만들지 않는다', async () => {
    expect(await tablesIn('public')).toEqual([]);
  });

  it('마이그레이션 기록 테이블이 om 스키마에 있고 적용 기록이 들어 있다', async () => {
    expect(await tablesIn(MIGRATIONS_SCHEMA, MIGRATIONS_TABLE)).toEqual([MIGRATIONS_TABLE]);

    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} ORDER BY name`,
    );
    expect(rows.map((row) => row.name)).toEqual(MIGRATION_NAMES);
  });

  it('전부 down → up 왕복이 오류 없이 끝나고 같은 상태로 돌아온다', async () => {
    const reverted = await migrate(databaseUrl, 'down');
    expect(reverted).toEqual(MIGRATION_NAMES.toReversed());
    // om 스키마 자체는 기록 테이블이 들어 있어 남는다 (db/migrations의 첫 마이그레이션 주석 참고).
    expect(await tablesIn('om')).toEqual([MIGRATIONS_TABLE]);
    expect(await tablesIn('public')).toEqual([]);

    const applied = await migrate(databaseUrl, 'up');
    expect(applied).toEqual(MIGRATION_NAMES);
    expect(await hasOmSchema()).toBe(true);
    expect(await tablesIn('om', 'auth\_%')).toEqual(AUTH_TABLES);
  });

  it('이미 최신이면 up을 다시 실행해도 적용할 것이 없다', async () => {
    expect(await migrate(databaseUrl, 'up')).toEqual([]);
  });
});
