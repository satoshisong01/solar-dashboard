// .mts: 이 저장소는 CommonJS 패키지라 .ts 설정 파일은 Vite 8이 경고를 낸다 (Next 문서 예시도 .mts).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// integration 전용. .env.test.local만 읽는다. 없으면 globalSetup이 안내 오류로 실패한다.
const testEnvFile = fromRoot('./.env.test.local');
const testEnv = existsSync(testEnvFile) ? parseEnv(readFileSync(testEnvFile, 'utf8')) : {};

export default defineConfig({
  // Vite의 .env 자동 로딩을 끈다: .env.local(운영 접속정보)을 읽지 않는다.
  envDir: false,
  resolve: {
    tsconfigPaths: true, // @/ 경로
    alias: { 'server-only': fromRoot('./tests/stubs/server-only.ts') },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['lib/**/*.test.ts', 'components/**/*.test.ts', 'db/seed/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          env: testEnv,
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false, // 테스트 DB 하나를 공유한다
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['lib/**'],
      // P0에서는 임계치를 강제하지 않는다. P2에서 lib/analytics/** 80%를 강제할 예정:
      // thresholds: { 'lib/analytics/**': { lines: 80, functions: 80, branches: 80, statements: 80 } },
    },
  },
});
