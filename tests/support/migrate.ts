// npm run db:migrate(:test)와 같은 설정으로 node-pg-migrate를 프로그램에서 실행한다.
import { runner } from 'node-pg-migrate';
import { resolve } from 'node:path';

export const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

type Direction = 'up' | 'down';

/** 기본값은 방향과 무관하게 전부 적용(up) 또는 전부 되돌리기(down). 실행한 마이그레이션 이름을 돌려준다. */
export async function migrate(databaseUrl: string, direction: Direction, count = Infinity): Promise<string[]> {
  const ran = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: 'pgmigrations', // CLI 기본값
    checkOrder: true,
    log: () => {}, // 실패는 예외로 드러나므로 진행 로그는 숨긴다
  });
  return ran.map((migration) => migration.name);
}
