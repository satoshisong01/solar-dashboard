// 'server-only'를 넣지 않는다: scripts/admin-create.ts(tsx)도 같은 설정을 쓴다.
// 앱 코드는 lib/auth/auth.ts의 getAuth()를 사용한다.
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { admin } from 'better-auth/plugins';
import { getPool } from '@/lib/db/pool';
import { getServerEnv } from '@/lib/env';

const HOUR_S = 60 * 60;

/** 환경변수를 검증하고 인스턴스를 만든다. 테이블 이름은 db/migrations의 auth 마이그레이션과 일치해야 한다. */
export function createAuth() {
  const env = getServerEnv();

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: getPool(),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // 계정은 scripts/admin-create.ts 또는 관리자만 만든다
      minPasswordLength: 12,
    },
    user: { modelName: 'auth_user' },
    session: {
      modelName: 'auth_session',
      expiresIn: 8 * HOUR_S,
      updateAge: HOUR_S,
    },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    // 서버리스 인스턴스끼리 공유되도록 DB에 저장한다. 기본값대로 production에서만 동작한다.
    rateLimit: { storage: 'database', modelName: 'auth_rate_limit' },
    plugins: [admin(), nextCookies()], // nextCookies는 항상 마지막
  });
}

export type Auth = ReturnType<typeof createAuth>;
