// 실행 중인 로컬 PostgreSQL을 pg_ctl stop(fast)으로 종료한다 (npm run db:down).
import { existsSync } from 'node:fs';
import { LOCAL_PG, loadBinaries, log, stopServer } from './local-pg';

async function main(): Promise<void> {
  if (!existsSync(LOCAL_PG.pidFile)) {
    log('실행 중인 로컬 서버가 없습니다.');
    return;
  }

  const bins = await loadBinaries();
  if (stopServer(bins)) {
    log('로컬 서버를 종료했습니다.');
  } else {
    log(`종료하지 못했습니다. ${LOCAL_PG.pidFile} 상태를 확인하세요.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[db] 종료 실패:', error instanceof Error ? error.message : error);
  process.exit(1);
});
