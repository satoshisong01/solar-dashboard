// 로컬 개발 전용 embedded-postgres 설정과 공용 함수. 운영 DB와 무관하다.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod';

const dataDir = resolve(process.cwd(), '.data', 'pg'); // npm 스크립트는 저장소 루트에서 실행된다

export const LOCAL_PG = Object.freeze({
  dataDir,
  pidFile: join(dataDir, 'postmaster.pid'),
  host: 'localhost',
  port: 54320,
  user: 'hysol',
  password: 'hysol',
  databases: Object.freeze(['hysol', 'hysol_test']),
});

const binariesSchema = z.object({ pg_ctl: z.string(), postgres: z.string() });
export type PgBinaries = z.infer<typeof binariesSchema>;

/** embedded-postgres가 설치한 플랫폼 패키지(예: @embedded-postgres/windows-x64)의 바이너리 경로 */
export async function loadBinaries(): Promise<PgBinaries> {
  const os = platform() === 'win32' ? 'windows' : platform();
  const mod: unknown = await import(`@embedded-postgres/${os}-${arch()}`);
  return binariesSchema.parse(mod);
}

export function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

/** pg_ctl로 fast shutdown을 요청하고 완전히 멈출 때까지 기다린다. 멈췄으면 true. */
export function stopServer(bins: PgBinaries): boolean {
  try {
    execFileSync(bins.pg_ctl, ['stop', '-D', LOCAL_PG.dataDir, '-m', 'fast', '-w'], {
      stdio: 'inherit',
      env: { ...process.env, LC_MESSAGES: 'C' }, // 한국어 Windows에서 CP949 메시지가 깨지지 않게
    });
  } catch {
    // 이미 종료 중이거나 종료된 경우에도 실패한다. 결과는 PID 파일로 판단한다.
  }
  return !existsSync(LOCAL_PG.pidFile);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 로컬 전용 스크립트의 안전장치: DATABASE_URL이 localhost:54320(embedded-postgres)이 아니면 예외. */
export function assertLocalDatabaseUrl(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  if (!LOCAL_HOSTS.has(url.hostname) || url.port !== String(LOCAL_PG.port)) {
    throw new Error(
      `로컬 DB(localhost:${LOCAL_PG.port})가 아니어서 중단합니다: ${url.hostname}:${url.port || '5432'}`,
    );
  }
  return url;
}

export function log(message: string): void {
  console.log(`[db] ${message}`);
}
