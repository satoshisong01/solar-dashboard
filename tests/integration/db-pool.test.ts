// 앱 연결 풀(lib/db/pool.ts)의 search_path (hysol_test).
// Better Auth 어댑터는 auth_* 테이블을 스키마 없이 조회하고 우리 테이블은 om 스키마에만 있으므로,
// 실제 연결이 om을 먼저 보는지 확인한다.
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db/pool';
import { assertTestDatabaseUrl } from '../support/test-env';

assertTestDatabaseUrl(process.env.DATABASE_URL);

describe('앱 연결 풀 search_path (hysol_test)', () => {
  afterAll(() => closePool());

  it('연결이 om, public 순서의 search_path로 시작한다', async () => {
    const { rows } = await getPool().query<{ schemas: string[] }>('SELECT current_schemas(false)::text[] AS schemas');

    expect(rows[0]?.schemas).toEqual(['om', 'public']);
  });

  it('스키마를 붙이지 않은 auth_* 이름이 om 테이블로 풀린다', async () => {
    const { rows } = await getPool().query<{ table_name: string; same: boolean }>(
      `SELECT t.table_name, t.table_name::regclass = ('om.' || quote_ident(t.table_name))::regclass AS same
       FROM unnest(ARRAY['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'auth_rate_limit']) AS t(table_name)`,
    );

    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.same)).toBe(true);
  });
});
