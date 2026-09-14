// E2E globalSetup 전용: 가상 사이트 하나를 짧게 시뮬레이션해 실제 수집 API(POST /api/ingest/v1)로 적재한다.
// sim:backfill과 같은 시뮬레이터·서명 전송기를 쓰되, 적재 끝을 "지금"에 맞춰 플릿 신선도가 정상으로 보이게 한다.
import { SIM_SITES } from '../../db/seed/sites';
import { runBatches } from '../../lib/sim/batch-runner';
import { createHttpEmitter, type GatewayCredential } from '../../lib/sim/emit-http';
import { simulate, type Scenario } from '../../lib/sim/index';
import type { RunSummary } from '../../lib/sim/manifest';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../../lib/sim/math';
import { E2E_INGEST_SITE } from './e2e-env';

const INGEST = Object.freeze({
  days: 2,
  seed: 42,
  /** 배치 창 60분 (sim:backfill 기본값과 같음). 창당 샘플이 많으면 시뮬레이터가 나눠 보낸다 */
  batchMinutes: 60,
  concurrency: 4,
});

/**
 * dq 프리셋 일부 (설계 §5.5): 중복 배치 5%, 게이트웨이 6시간 단절 후 백필, 저장탱크 압력 스파이크, 수소 누출 1차 경보 1회.
 * 경보는 안전 배너 시나리오에, 미매핑 태그(COMP1/VIB_RMS 등)는 사이트 정의대로 매핑 시나리오에 쓰인다.
 */
function scenarios(site: string, fromMs: number, toMs: number): readonly Scenario[] {
  return [
    { kind: 'dq.duplicate_batches', site, ratio: 0.05 },
    { kind: 'dq.gateway_outage', site, start: fromMs + 10 * MS_PER_HOUR, durationS: 6 * 3_600 },
    { kind: 'dq.spike', site, sourceKey: 'H2BANK1/TANK1/P', perDay: 1 },
    { kind: 'safety.h2_leak_alarm', site, at: toMs - 3 * MS_PER_HOUR },
  ];
}

function credentialsFor(site: string, secrets: ReadonlyMap<string, string>): ReadonlyMap<string, GatewayCredential> {
  const def = SIM_SITES.find((candidate) => candidate.code === site);
  const secret = def ? secrets.get(def.gateway.code) : undefined;
  if (!def || !secret) throw new Error(`${site} 게이트웨이 비밀값이 없습니다`);
  return new Map([[def.gateway.code, { keyId: def.gateway.keyId, secret }]]);
}

function assertComplete(summary: RunSummary): void {
  const expected = Object.values(summary.sites).reduce((sum, site) => sum + site.expectedSamples, 0);
  const problems = [
    summary.results.failed > 0 ? `실패 배치 ${summary.results.failed}건: ${summary.failures.slice(0, 3).join(' / ')}` : null,
    summary.results.conflict > 0 ? `409 배치 ${summary.results.conflict}건` : null,
    summary.samples.accepted !== expected ? `적재 샘플 ${summary.samples.accepted} ≠ 기대 ${expected}` : null,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) throw new Error(`E2E 시뮬레이터 적재가 완전하지 않습니다: ${problems.join(', ')}`);
}

/** 최근 INGEST.days일(지금 분 단위까지)을 적재하고 요약을 돌려준다. 실패·409·샘플 수 불일치면 예외. */
export async function ingestSimulatedSite(baseUrl: string, secrets: ReadonlyMap<string, string>): Promise<RunSummary> {
  const site = E2E_INGEST_SITE;
  const startedAt = Date.now();
  const toMs = Math.floor(startedAt / MS_PER_MINUTE) * MS_PER_MINUTE;
  const fromMs = toMs - INGEST.days * MS_PER_DAY;

  const emitter = createHttpEmitter({ baseUrl, credentials: credentialsFor(site, secrets) });
  const source = simulate({
    siteCodes: [site],
    from: fromMs,
    to: toMs,
    seed: INGEST.seed,
    scenarios: scenarios(site, fromMs, toMs),
    batchPeriodS: INGEST.batchMinutes * 60,
    serverNowMs: startedAt,
  });
  const summary = await runBatches(source, { concurrency: INGEST.concurrency, emit: (batch) => emitter.emit(batch) });
  assertComplete(summary);

  console.log(
    `[e2e] ${site} ${INGEST.days}일 적재: 배치 ${summary.batches}(중복 재전송 ${summary.resends}, 단절 백필 ${summary.backfillBatches}) · ` +
      `샘플 ${summary.samples.accepted} · 미매핑 ${summary.samples.unmapped} · 이벤트 ${summary.samples.events} · ${Date.now() - startedAt} ms`,
  );
  return summary;
}
