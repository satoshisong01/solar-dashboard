// node-pg-migrate를 프로그램 API로 실행한다. npm run db:migrate(scripts/db-migrate.ts)와 integration·e2e 테스트가 같은 설정을 쓴다.
// 'server-only'를 넣지 않는다: tsx 스크립트와 테스트에서만 import한다 (앱 코드는 import하지 않음).
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import type { ClientConfig } from 'pg';

export const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations'); // npm 스크립트는 저장소 루트에서 실행된다
/** node-pg-migrate CLI 기본값과 같은 이름. 스키마만 om으로 옮긴다 */
export const MIGRATIONS_TABLE = 'pgmigrations';
/** 우리 객체는 기록 테이블까지 전부 이 스키마 안에만 만든다 (운영 DB의 public은 다른 프로젝트와 공유) */
export const MIGRATIONS_SCHEMA = 'om';

export type MigrationDirection = 'up' | 'down';

export interface RunMigrationsOptions {
  /** 연결 문자열, 또는 SSL 등을 담은 pg 연결 설정 */
  readonly connection: string | ClientConfig;
  readonly direction: MigrationDirection;
  /** 적용·되돌릴 개수. 기본 Infinity(전부) */
  readonly count?: number;
  /** 진행 메시지. 없으면 출력하지 않는다 (실패는 예외로 드러난다) */
  readonly log?: (message: string) => void;
}

/** 마이그레이션을 실행하고 실행한 이름을 순서대로 돌려준다. 잠금(advisory lock)·순서 검사·단일 트랜잭션은 CLI 기본값과 같다. */
export async function runMigrations(options: RunMigrationsOptions): Promise<string[]> {
  const ran = await runner({
    databaseUrl: options.connection,
    dir: MIGRATIONS_DIR,
    direction: options.direction,
    count: options.count ?? Infinity,
    migrationsTable: MIGRATIONS_TABLE,
    // schema: 마이그레이션 SQL의 search_path. 스키마를 안 붙인 DDL이 public에 생기지 않게 한다.
    // migrationsSchema: 기록 테이블(om.pgmigrations)이 놓일 스키마.
    // create*Schema: 둘 다 기록 테이블을 만들기 전에 CREATE SCHEMA IF NOT EXISTS를 실행하므로 빈 DB에서도 첫 실행이 된다.
    schema: MIGRATIONS_SCHEMA,
    createSchema: true,
    migrationsSchema: MIGRATIONS_SCHEMA,
    createMigrationsSchema: true,
    checkOrder: true,
    singleTransaction: true,
    log: options.log ?? (() => {}),
  });
  return ran.map((migration) => migration.name);
}
