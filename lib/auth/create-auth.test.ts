import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://hysol:hysol@localhost:54320/hysol_test',
  INGEST_KEY_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
  BETTER_AUTH_SECRET: 'b'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3100',
} as const;

// 풀은 쿼리 전까지 연결하지 않는다. 테스트가 만든 풀은 끝에 닫고 전역 캐시를 비운다.
const globalForPool = globalThis as typeof globalThis & { __hysolPool?: { end(): Promise<void> } };

async function createAuthWith(trustedOrigins: string | undefined) {
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('DATABASE_SSL', undefined);
  vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', trustedOrigins);
  vi.resetModules();
  const { createAuth } = await import('./create-auth');
  return createAuth();
}

afterEach(async () => {
  await globalForPool.__hysolPool?.end();
  delete globalForPool.__hysolPool;
  vi.unstubAllEnvs();
});

// 매 테스트가 모듈을 초기화하고 better-auth를 새로 불러온다. 전체 unit 실행에서 무거운 시뮬레이션 테스트와 CPU를 나눠 쓰면
// 이 첫 import가 기본 제한 5초를 넘은 적이 있어(6.1초) 검사 대상이 아닌 import 시간 때문에 실패하지 않도록 제한을 늘린다.
const IMPORT_TIMEOUT_MS = 30_000;

describe('createAuth', { timeout: IMPORT_TIMEOUT_MS }, () => {
  it('BETTER_AUTH_TRUSTED_ORIGINS 목록을 trustedOrigins로 넘긴다', async () => {
    const auth = await createAuthWith('https://desk.example.com, https://preview.example.com');

    expect(auth.options.trustedOrigins).toEqual(['https://desk.example.com', 'https://preview.example.com']);
    expect(auth.options.baseURL).toBe(BASE_ENV.BETTER_AUTH_URL);
  });

  it('설정하지 않으면 추가로 신뢰하는 origin이 없다', async () => {
    const auth = await createAuthWith(undefined);

    expect(auth.options.trustedOrigins).toEqual([]);
  });
});
