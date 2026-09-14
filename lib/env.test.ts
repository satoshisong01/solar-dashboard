import { afterEach, describe, expect, it, vi } from 'vitest';

const VALID_ENV = {
  DATABASE_URL: 'postgres://hysol:hysol@localhost:54320/hysol_test',
  INGEST_KEY_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3100',
} as const;

const OPTIONAL_KEYS = ['DATABASE_SSL', 'DATABASE_SSL_CA_PATH', 'BETTER_AUTH_TRUSTED_ORIGINS'] as const;

type EnvKey = keyof typeof VALID_ENV | (typeof OPTIONAL_KEYS)[number];
type EnvOverrides = Partial<Record<EnvKey, string | undefined>>;

function stubServerEnv(overrides: EnvOverrides = {}): void {
  // 개발자 셸에 선택 변수가 있어도 결과가 흔들리지 않게 먼저 지운다. undefined로 stub하면 변수가 지워진다.
  for (const key of OPTIONAL_KEYS) vi.stubEnv(key, undefined);
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
  it('유효한 값이면 스키마 변수만 담은 고정 객체를 돌려주고 캐시한다', async () => {
    stubServerEnv();
    vi.stubEnv('DB_HOST', 'should-not-leak');
    const getServerEnv = await loadGetServerEnv();

    const env = getServerEnv();

    expect(env).toEqual({ ...VALID_ENV, DATABASE_SSL: 'disable', BETTER_AUTH_TRUSTED_ORIGINS: [] });
    expect(env).not.toHaveProperty('DB_HOST');
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.BETTER_AUTH_TRUSTED_ORIGINS)).toBe(true);
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

  it('DATABASE_URL에 sslmode가 있으면 DATABASE_SSL을 쓰라고 안내한다', async () => {
    stubServerEnv({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/hysol?sslmode=require' });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/DATABASE_SSL을 사용하세요[\s\S]*DATABASE_URL/);
  });
});

describe('getServerEnv — 수집 키 암호화 키', () => {
  it('INGEST_KEY_ENC_KEY가 없으면 오류를 던진다', async () => {
    stubServerEnv({ INGEST_KEY_ENC_KEY: undefined });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/INGEST_KEY_ENC_KEY/);
  });

  it.each([
    ['31바이트', Buffer.alloc(31, 1).toString('base64')],
    ['33바이트', Buffer.alloc(33, 1).toString('base64')],
    ['hex 문자열', Buffer.alloc(32, 1).toString('hex')],
  ])('%s 키는 거부한다', async (_label, value) => {
    stubServerEnv({ INGEST_KEY_ENC_KEY: value });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/base64로 인코딩한 32바이트 키여야 합니다[\s\S]*INGEST_KEY_ENC_KEY/);
  });
});

describe('getServerEnv — DATABASE_SSL', () => {
  it('빈 값은 기본값 disable로 본다', async () => {
    stubServerEnv({ DATABASE_SSL: '', DATABASE_SSL_CA_PATH: '' });
    const getServerEnv = await loadGetServerEnv();

    const env = getServerEnv();
    expect(env.DATABASE_SSL).toBe('disable');
    expect(env.DATABASE_SSL_CA_PATH).toBeUndefined();
  });

  it('require는 CA 경로 없이 허용한다', async () => {
    stubServerEnv({ DATABASE_SSL: 'require' });
    const getServerEnv = await loadGetServerEnv();

    expect(getServerEnv().DATABASE_SSL).toBe('require');
  });

  it('verify-full인데 CA 경로가 없으면 오류를 던진다', async () => {
    stubServerEnv({ DATABASE_SSL: 'verify-full' });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/CA 번들 파일 경로가 필요합니다[\s\S]*DATABASE_SSL_CA_PATH/);
  });

  it('verify-full과 CA 경로를 함께 주면 그대로 담는다', async () => {
    stubServerEnv({ DATABASE_SSL: 'verify-full', DATABASE_SSL_CA_PATH: 'certs/global-bundle.pem' });
    const getServerEnv = await loadGetServerEnv();

    expect(getServerEnv()).toMatchObject({
      DATABASE_SSL: 'verify-full',
      DATABASE_SSL_CA_PATH: 'certs/global-bundle.pem',
    });
  });

  it('알 수 없는 모드는 거부한다', async () => {
    stubServerEnv({ DATABASE_SSL: 'prefer' });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/disable, require, verify-full 중 하나여야 합니다[\s\S]*DATABASE_SSL/);
  });
});

describe('getServerEnv — BETTER_AUTH_TRUSTED_ORIGINS', () => {
  it('쉼표 목록을 공백 제거한 배열로 바꾸고 빈 항목은 버린다', async () => {
    stubServerEnv({ BETTER_AUTH_TRUSTED_ORIGINS: ' https://desk.example.com, http://localhost:3100 ,' });
    const getServerEnv = await loadGetServerEnv();

    expect(getServerEnv().BETTER_AUTH_TRUSTED_ORIGINS).toEqual(['https://desk.example.com', 'http://localhost:3100']);
  });

  it('http(s)가 아닌 항목이 있으면 오류를 던진다', async () => {
    stubServerEnv({ BETTER_AUTH_TRUSTED_ORIGINS: 'https://desk.example.com,ftp://files.example.com' });
    const getServerEnv = await loadGetServerEnv();

    expect(() => getServerEnv()).toThrow(/origin 목록이어야 합니다[\s\S]*BETTER_AUTH_TRUSTED_ORIGINS/);
  });
});
