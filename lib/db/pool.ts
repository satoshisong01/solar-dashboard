// 'server-only'를 넣지 않는다: tsx 스크립트와 테스트에서도 import한다.
import { Pool } from 'pg';
import { getServerEnv } from '@/lib/env';

const POOL_MAX = 5; // 서버리스 인스턴스마다 풀이 생기므로 작게 유지
const IDLE_TIMEOUT_MS = 5_000;

// 개발 중 HMR로 모듈이 다시 평가돼도 풀은 하나만 유지한다.
const globalForPool = globalThis as typeof globalThis & {
  __hysolPool?: Pool;
};

export function getPool(): Pool {
  const existing = globalForPool.__hysolPool;
  if (existing) return existing;

  const pool = new Pool({
    connectionString: getServerEnv().DATABASE_URL,
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
