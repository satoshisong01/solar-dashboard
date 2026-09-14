// 로컬 PostgreSQL을 포그라운드로 실행한다 (npm run db:up). Ctrl+C 또는 npm run db:down으로 종료.
// embedded-postgres의 stop()은 Windows에서 taskkill /f(강제 종료)라서,
// 기동은 postgres를 직접 spawn하고 종료는 pg_ctl stop(fast)으로 한다.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { LOCAL_PG, isPortOpen, loadBinaries, log, stopServer, type PgBinaries } from './local-pg';

const READY_MESSAGE = 'database system is ready to accept connections';
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

async function initialiseIfNeeded(): Promise<void> {
  if (existsSync(join(LOCAL_PG.dataDir, 'PG_VERSION'))) return;

  log(`데이터 디렉터리 초기화: ${LOCAL_PG.dataDir}`);
  // 최초 1회만 필요하므로 여기서만 불러온다.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  await new EmbeddedPostgres({
    databaseDir: LOCAL_PG.dataDir,
    port: LOCAL_PG.port,
    user: LOCAL_PG.user,
    password: LOCAL_PG.password,
    authMethod: 'scram-sha-256',
    persistent: true,
    // 한국어 Windows 기본 로케일(CP949)은 서버 인코딩으로 쓸 수 없어 명시한다.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  }).initialise();
}

function startPostgres(bins: PgBinaries): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bins.postgres,
      // RDS 기본값과 맞춰 세션 시간대를 UTC로 둔다 (date_trunc 등 일 단위 집계에 영향).
      ['-D', LOCAL_PG.dataDir, '-p', String(LOCAL_PG.port), '-c', 'timezone=UTC'],
      { stdio: ['ignore', 'inherit', 'pipe'] },
    );
    const onEarlyExit = (code: number | null) =>
      reject(new Error(`PostgreSQL이 기동 중 종료됐습니다 (exit ${code})`));

    child.once('error', reject);
    child.once('exit', onEarlyExit);

    createInterface({ input: child.stderr }).on('line', (line) => {
      console.log(`[pg] ${line}`);
      if (line.includes(READY_MESSAGE)) {
        child.off('exit', onEarlyExit);
        resolve(child);
      }
    });
  });
}

async function ensureDatabases(): Promise<void> {
  const client = new pg.Client({
    host: LOCAL_PG.host,
    port: LOCAL_PG.port,
    user: LOCAL_PG.user,
    password: LOCAL_PG.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
      [LOCAL_PG.databases],
    );
    const existing = new Set(rows.map((row) => row.datname));
    for (const name of LOCAL_PG.databases.filter((db) => !existing.has(db))) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
      log(`DB 생성: ${name}`);
    }
  } finally {
    await client.end();
  }
}

function handleShutdown(child: ChildProcess, bins: PgBinaries): void {
  let stopping = false;

  // 동기 종료: 핸들러가 끝나기 전에 Node가 먼저 종료되면 postgres가 강제 종료되기 때문.
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} 수신, PostgreSQL 종료 중...`);
    const stopped = stopServer(bins);
    log(stopped ? '정상 종료했습니다.' : '종료를 확인하지 못했습니다.');
    process.exit(stopped ? 0 : 1);
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);

  // db:down 등 외부에서 멈춘 경우
  child.once('exit', (code) => {
    if (stopping) return;
    log(`PostgreSQL이 종료됐습니다 (exit ${code}).`);
    process.exit(code === 0 ? 0 : 1);
  });
}

async function main(): Promise<void> {
  const { host, port, user, databases } = LOCAL_PG;
  if (await isPortOpen(port, host)) {
    log(`포트 ${port}에 이미 서버가 떠 있습니다. 그대로 사용하거나 npm run db:down으로 종료하세요.`);
    return;
  }

  const bins = await loadBinaries();
  await initialiseIfNeeded();
  const child = await startPostgres(bins);
  handleShutdown(child, bins);
  try {
    await ensureDatabases();
  } catch (error) {
    stopServer(bins);
    throw error;
  }

  log(`준비 완료: postgres://${user}:***@${host}:${port}/{${databases.join(',')}}`);
  log('이 터미널을 켜 두세요. 종료: Ctrl+C 또는 다른 터미널에서 npm run db:down');
}

main().catch((error: unknown) => {
  console.error('[db] 기동 실패:', error instanceof Error ? error.message : error);
  process.exit(1);
});
