import { defineConfig, devices } from '@playwright/test';
import { ADMIN_STORAGE_STATE, E2E_BASE_URL, E2E_PORT } from './tests/e2e/e2e-env';
import { readTestEnvFile } from './tests/support/test-env';

const testEnv = readTestEnvFile();

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  // 테스트 DB와 로그인 rate limit(Better Auth 기본값: 10초에 3회)을 공유하므로 순서대로 실행한다.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testIgnore: /logout\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ADMIN_STORAGE_STATE },
    },
    {
      // 로그아웃은 공유 세션을 끝내므로 다른 테스트가 모두 끝난 뒤 실행한다.
      name: 'logout',
      testMatch: /logout\.spec\.ts/,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'], storageState: ADMIN_STORAGE_STATE },
    },
  ],
  // Next 문서 권고대로 프로덕션 빌드를 대상으로 한다. 개발 서버(3000)와 겹치지 않게 3100을 쓴다.
  webServer: {
    command: `npm run build && npx next start -p ${E2E_PORT}`,
    // DB를 쓰지 않는 정적 경로로 기동을 확인한다. /login은 DB가 꺼져 있으면 500이라 대기가 끝나지 않고,
    // 그러면 globalSetup의 "먼저 npm run db:up" 안내까지 가지 못한다.
    url: `${E2E_BASE_URL}/favicon.ico`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL: testEnv.DATABASE_URL ?? '',
      BETTER_AUTH_SECRET: testEnv.BETTER_AUTH_SECRET ?? '',
      BETTER_AUTH_URL: E2E_BASE_URL,
      INGEST_KEY_ENC_KEY: testEnv.INGEST_KEY_ENC_KEY ?? '',
    },
  },
});
