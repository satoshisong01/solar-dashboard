// 'server-only'를 넣지 않는다: tsx 스크립트와 테스트에서도 import한다.
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { ConnectionOptions } from 'node:tls';
import { getServerEnv, type ServerEnv } from '@/lib/env';

const POOL_MAX = 5; // 서버리스 인스턴스마다 풀이 생기므로 작게 유지
const IDLE_TIMEOUT_MS = 5_000;

type SslEnv = Pick<ServerEnv, 'DATABASE_SSL' | 'DATABASE_SSL_CA_PATH'>;
type ReadCaFile = (path: string) => string;

/**
 * DATABASE_SSL을 pg의 ssl 옵션으로 바꾼다. false를 명시해 PGSSLMODE 환경변수가 끼어들지 않게 한다.
 * - disable: 암호화 없음 (로컬 embedded-postgres)
 * - require: 암호화만, 서버 인증서는 검증하지 않음 (libpq sslmode=require와 같은 의미. 운영에는 쓰지 않는다)
 * - verify-full: CA 번들로 인증서 체인과 호스트 이름을 검증 (운영 RDS)
 */
export function buildSslOptions(env: SslEnv, readCaFile: ReadCaFile = (path) => readFileSync(path, 'utf8')): false | ConnectionOptions {
  switch (env.DATABASE_SSL) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full': {
      const caPath = env.DATABASE_SSL_CA_PATH;
      if (!caPath) throw new Error('DATABASE_SSL=verify-full이면 DATABASE_SSL_CA_PATH가 필요합니다');
      try {
        return { ca: readCaFile(caPath), rejectUnauthorized: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`DATABASE_SSL_CA_PATH의 CA 번들을 읽지 못했습니다 (${caPath}): ${reason}`);
      }
    }
  }
}

/** 연결을 기다리는 요청이 풀 크기만큼 쌓였으면 true (수집 API가 429로 부하를 돌려보낸다) */
export function isPoolSaturated(pool: Pick<Pool, 'waitingCount'>): boolean {
  return pool.waitingCount >= POOL_MAX;
}

// 개발 중 HMR로 모듈이 다시 평가돼도 풀은 하나만 유지한다.
const globalForPool = globalThis as typeof globalThis & {
  __hysolPool?: Pool;
};

export function getPool(): Pool {
  const existing = globalForPool.__hysolPool;
  if (existing) return existing;

  const env = getServerEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: buildSslOptions(env),
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  });
  // 유휴 연결 오류를 처리하지 않으면 프로세스가 죽는다.
  pool.on('error', (error) => {
    console.error('[db] 유휴 연결 오류:', error.message);
  });

  globalForPool.__hysolPool = pool;
  return pool;
}
