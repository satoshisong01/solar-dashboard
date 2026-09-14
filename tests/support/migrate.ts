// npm run db:migrate(:test)와 같은 설정으로 node-pg-migrate를 프로그램에서 실행한다.
import { MIGRATIONS_DIR, runMigrations, type MigrationDirection } from '../../lib/db/migrate';

export { MIGRATIONS_DIR };

/** 기본값은 방향과 무관하게 전부 적용(up) 또는 전부 되돌리기(down). 실행한 마이그레이션 이름을 돌려준다. */
export async function migrate(databaseUrl: string, direction: MigrationDirection, count = Infinity): Promise<string[]> {
  return runMigrations({ connection: databaseUrl, direction, count });
}
