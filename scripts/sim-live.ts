// 현재 시각부터 5분 창마다 가상 사이트 데이터를 실시간으로 수집 API에 보낸다 (고장·데이터 품질 시나리오 없음). Ctrl+C로 끝낸다.
//   npm run sim:live -- --sites SIM-A,SIM-B,SIM-C --seed 42 --base-url http://localhost:3000
// 초기 설비 상태는 시작 시각으로 추정하므로 sim:backfill 데이터와 값이 이어지지는 않는다.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createHttpEmitter } from '../lib/sim/emit-http';
import { DEFAULT_BATCH_PERIOD_S, simulate } from '../lib/sim/index';
import { MS_PER_DAY, MS_PER_SECOND } from '../lib/sim/math';
import { assertIngestReachable, formatCount, formatKst, loadGatewayCredentials, parseBaseUrl, parseIntegerOption, parseSiteCodes } from './sim-shared';

/** 사실상 무기한 (시뮬레이터는 끝 시각이 필요하다) */
const LIVE_HORIZON_MS = 365 * MS_PER_DAY;

function readConfig() {
  const { values } = parseArgs({
    options: {
      sites: { type: 'string', default: 'SIM-A,SIM-B,SIM-C' },
      seed: { type: 'string', default: '42' },
      'base-url': { type: 'string', default: 'http://localhost:3000' },
    },
  });
  return {
    sites: parseSiteCodes(values.sites),
    seed: parseIntegerOption('seed', values.seed, 0, 2 ** 31 - 1),
    baseUrl: parseBaseUrl(values['base-url']),
  };
}

const clockTime = (ms: number) => formatKst(ms).slice(11);

async function main(): Promise<void> {
  const config = readConfig();
  const credentials = loadGatewayCredentials(config.sites);
  await assertIngestReachable(config.baseUrl);

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const batchMs = DEFAULT_BATCH_PERIOD_S * MS_PER_SECOND;
  const startMs = Math.floor(Date.now() / batchMs) * batchMs;
  const emitter = createHttpEmitter({ baseUrl: config.baseUrl, credentials });
  console.log(`[live] ${config.sites.join(',')} · 시드 ${config.seed} → ${config.baseUrl} · ${formatKst(startMs)}부터 5분마다 전송 (첫 전송 ${clockTime(startMs + batchMs)}). 종료: Ctrl+C`);

  let sent = 0;
  let failed = 0;
  try {
    for await (const batch of simulate({ siteCodes: config.sites, from: startMs, to: startMs + LIVE_HORIZON_MS, seed: config.seed })) {
      const waitMs = batch.sentAtMs - Date.now();
      if (waitMs > 0) await sleep(waitMs, undefined, { signal: controller.signal });
      const result = await emitter.emit(batch);
      sent += 1;
      if (result.kind === 'failed' || result.kind === 'conflict') {
        failed += 1;
        console.error(`[live] ${clockTime(Date.now())} ${batch.siteCode} ${result.kind === 'failed' ? result.error : '409 같은 batch_id가 이미 있음'}`);
      } else {
        console.log(`[live] ${clockTime(Date.now())} ${batch.siteCode} ${result.kind} 샘플 ${formatCount(result.counts.accepted)} · 미매핑 ${formatCount(result.counts.unmapped)} · 이벤트 ${result.counts.events}`);
      }
      if (controller.signal.aborted) break;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  console.log(`[live] 종료: 보낸 배치 ${sent} · 실패 ${failed}`);
}

main().catch((error: unknown) => {
  console.error('[live] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
