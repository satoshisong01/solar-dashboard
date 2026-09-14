import { afterEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  DATABASE_URL: 'postgres://hysol:hysol@localhost:54320/hysol_test',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3100',
} as const;

type EnvOverrides = Partial<Record<keyof typeof VALID_ENV, string | undefined>>;

function stubServerEnv(overrides: EnvOverrides = {}): void {
  // undefined로 stub하면 변수가 지워진다
  for (const [key, value] of Object.entries({ ...VALID_ENV, ...overrides })) vi.stubEnv(key, value);
}

// getServerEnv()는 첫 결과를 모듈 안에 캐시하므로 테스트마다 모듈을 새로 불러온다.
async function loadGetServerEnv() {
  vi.resetModules();
  const { getServerEnv } = await import('./env');
  return getServerEnv;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerEnv', () => {
  it('유효한 값이면 세 변수만 담은 고정 객체를 돌려주고 캐시한다', async () => {
    stubServerEnv();
    vi.stubEnv('DB_HOST', 'should-not-leak');
    const getServerEnv = await loadGetServerEnv();

    const env = getServerEnv();

    expect(env).toEqual(VALID_ENV);
    expect(Object.isFrozen(env)).toBe(true);
    expect(getServerEnv()).toBe(env);
  });

  it('DATABASE_URL이 없으면 변수 이름을 담은 오류를 던진다', async () => {
    stubServerEnv({ DATABASE_URL: undefined });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/서버 환경변수 설정 오류[\s\S]*DATABASE_URL/);
  });

  it('BETTER_AUTH_SECRET이 32자 미만이면 길이 안내 오류를 던진다', async () => {
    stubServerEnv({ BETTER_AUTH_SECRET: 'a'.repeat(31) });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/32자 이상의 랜덤 문자열이어야 합니다[\s\S]*BETTER_AUTH_SECRET/);
  });

  it('DATABASE_URL이 postgres:// 형식이 아니면 오류를 던진다', async () => {
    stubServerEnv({ DATABASE_URL: 'mysql://hysol:hysol@localhost:3306/hysol' });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/postgres:\/\/ 형식의 URL이어야 합니다[\s\S]*DATABASE_URL/);
  });
});
