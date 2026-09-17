// 운영 DB에 적용된 마이그레이션 목록이 db/migrations 파일 목록과 정확히 같은지 본다 (scripts/deploy-check.ts).
// 코드는 배포됐는데 마이그레이션을 돌리지 않아 화면이 500을 내던 사고를 잡는 검사다. 순수 모듈.

export interface MigrationParity {
  /** 파일에는 있는데 운영에 적용되지 않은 것 (배포 후 db:migrate를 돌리지 않은 경우) */
  readonly missing: readonly string[];
  /** 운영에 적용됐는데 파일이 없는 것 (마이그레이션을 지운 코드를 배포한 경우) */
  readonly extra: readonly string[];
}

/** '20260914070310296_auth.sql' → '20260914070310296_auth' (om.pgmigrations.name 형식) */
const migrationName = (file: string): string => file.replace(/\.sql$/, '');

export function compareMigrations(files: readonly string[], applied: readonly string[]): MigrationParity {
  const expected = files.filter((file) => file.endsWith('.sql')).map(migrationName);
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((name) => !appliedSet.has(name)).sort(),
    extra: applied.filter((name) => !expectedSet.has(name)).sort(),
  };
}

export const isParityOk = (parity: MigrationParity): boolean => parity.missing.length === 0 && parity.extra.length === 0;
