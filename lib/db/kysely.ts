import { Kysely, PostgresDialect } from 'kysely';
import { getPool } from './pool';
import type { DB } from './types';

// 풀은 첫 쿼리 때 만들어진다. import만으로는 환경변수를 읽지 않는다.
export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: async () => getPool() }),
});
