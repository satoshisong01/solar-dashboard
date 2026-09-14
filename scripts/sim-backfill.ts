// 과거 N일치 가상 사이트 데이터를 실제 수집 API(POST /api/ingest/v1)로 적재한다. 서버(npm run dev)가 떠 있어야 한다.
//   npm run sim:backfill -- --days 30 --sites SIM-A,SIM-B,SIM-C --seed 42 --base-url http://localhost:3000 --scenario dq
// 끝나면 기대 고유 샘플 수를 출력하고, verify:ingest가 읽을 적재 기록(.data/sim/backfill-manifest.json)을 남긴다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MAX_FAILURES, runBatches } from '../lib/sim/batch-runner';
import { createHttpEmitter } from '../lib/sim/emit-http';
import { simulate } from '../lib/sim/index';
import { DEFAULT_MANIFEST_PATH, MANIFEST_VERSION, type BackfillManifest, type RunSummary } from '../lib/sim/manifest';
import { MS_PER_DAY, MS_PER_MINUTE } from '../lib/sim/math';
import { presetScenarios, SCENARIO_PRESETS, type ScenarioPreset } from '../lib/sim/presets';
import { assertIngestReachable, formatCount, formatDuration, formatKst, loadGatewayCredentials, parseBaseUrl, parseIntegerOption, parseSiteCodes } from './sim-shared';

const PROGRESS_INTERVAL_MS = 5_000;

interface BackfillConfig {
  readonly days: number;
  readonly sites: readonly string[];
  readonly seed: number;
  readonly baseUrl: string;
  readonly scenario: ScenarioPreset;
  readonly batchMinutes: number;
  readonly maxSamples: number;
  readonly concurrency: number;
  readonly manifestPath: string;
}

function readConfig(): BackfillConfig {
  const { values } = parseArgs({
    options: {
      days: { type: 'string', default: '30' },
      sites: { type: 'string', default: 'SIM-A,SIM-B,SIM-C' },
      seed: { type: 'string', default: '42' },
      'base-url': { type: 'string', default: 'http://localhost:3000' },
      scenario: { type: 'string', default: 'healthy' },
      'batch-minutes': { type: 'string', default: '60' },
      'max-samples': { type: 'string', default: '5000' },
      concurrency: { type: 'string', default: '4' },
      manifest: { type: 'string', default: DEFAULT_MANIFEST_PATH },
    },
  });
  const scenario = SCENARIO_PRESETS.find((preset) => preset === values.scenario);
  if (!scenario) throw new Error(`--scenario는 ${SCENARIO_PRESETS.join(' | ')} 중 하나여야 합니다 (받은 값: ${values.scenario})`);
  const batchMinutes = parseIntegerOption('batch-minutes', values['batch-minutes'], 1, 360);
  return {
    days: parseIntegerOption('days', values.days, 1, 366),
    sites: parseSiteCodes(values.sites),
    seed: parseIntegerOption('seed', values.seed, 0, 2 ** 31 - 1),
    baseUrl: parseBaseUrl(values['base-url']),
    scenario,
    batchMinutes,
    // 서버 봉투 상한은 20,000 샘플
    maxSamples: parseIntegerOption('max-samples', values['max-samples'], 100, 20_000),
    concurrency: parseIntegerOption('concurrency', values.concurrency, 1, 32),
    manifestPath: resolve(process.cwd(), values.manifest),
  };
}

function progressReporter(fromMs: number, toMs: number, startedAt: number) {
  let lastPrintAt = startedAt;
  let simulatedUntil = fromMs;
  return (summary: RunSummary, sentAtMs: number, final = false) => {
    simulatedUntil = Math.max(simulatedUntil, Math.min(sentAtMs, toMs));
    const now = Date.now();
    if (!final && now - lastPrintAt < PROGRESS_INTERVAL_MS) return;
    lastPrintAt = now;
    const elapsed = now - startedAt;
    const percent = ((simulatedUntil - fromMs) / (toMs - fromMs)) * 100;
    const rate = elapsed > 0 ? Math.round((summary.samples.accepted / elapsed) * 1_000) : 0;
    console.log(
      `[backfill] ${percent.toFixed(1)}% (${formatKst(simulatedUntil)}까지) · 배치 ${formatCount(summary.batches)} · ` +
        `적재 ${formatCount(summary.samples.accepted)} 샘플 (${formatCount(rate)}/초) · 실패 ${summary.results.failed} · 경과 ${formatDuration(elapsed)}`,
    );
  };
}

function printSummary(summary: RunSummary, elapsedMs: number): void {
  const siteRows = Object.entries(summary.sites);
  const expectedTotal = siteRows.reduce((sum, [, site]) => sum + site.expectedSamples, 0);
  console.log(`[backfill] 완료: ${formatDuration(elapsedMs)} · 배치 ${formatCount(summary.batches)} (재전송 ${formatCount(summary.resends)}, 단절 백필 ${formatCount(summary.backfillBatches)})`);
  console.log(
    `[backfill] 응답: accepted ${formatCount(summary.results.accepted)} · duplicate ${formatCount(summary.results.duplicate)} · ` +
      `409 ${formatCount(summary.results.conflict)} · 실패 ${formatCount(summary.results.failed)}`,
  );
  console.log(
    `[backfill] 서버 카운트: 적재 ${formatCount(summary.samples.accepted)} · 중복 ${formatCount(summary.samples.duplicate)} · ` +
      `미매핑 ${formatCount(summary.samples.unmapped)} · 거부 ${formatCount(summary.samples.rejected)} · 이벤트 ${formatCount(summary.samples.events)}`,
  );
  for (const [code, site] of siteRows) {
    console.log(
      `[backfill]   ${code}: 기대 고유 샘플 ${formatCount(site.expectedSamples)} · 미매핑 ${formatCount(site.expectedUnmappedSamples)} · ` +
        `CLOCK_SUSPECT 기대 ${formatCount(site.clockSuspectSamples)} · critical 이벤트 ${site.criticalEvents}`,
    );
  }
  console.log(`[backfill] 기대 고유 샘플 수(미매핑 제외) 합계: ${formatCount(expectedTotal)}`);
  if (summary.results.conflict > 0) {
    console.warn('[backfill] 409: 같은 batch_id로 본문이 다른 배치가 이미 있습니다(sent_at을 전송 시각으로 바꿔 보내던 이전 전송기로 적재한 데이터일 수 있음). 샘플은 이미 들어 있습니다. 처음부터 다시 만들려면 README "데모 데이터 만들기"를 보세요.');
  }
  summary.failures.forEach((failure) => console.error(`[backfill] 실패: ${failure}`));
}

function writeManifest(path: string, manifest: BackfillManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[backfill] 적재 기록: ${path}`);
}

async function main(): Promise<void> {
  const config = readConfig();
  const credentials = loadGatewayCredentials(config.sites);
  await assertIngestReachable(config.baseUrl);

  const startedAt = Date.now();
  const batchMs = config.batchMinutes * MS_PER_MINUTE;
  const toMs = Math.floor(startedAt / batchMs) * batchMs; // 마지막 배치 창까지 모두 과거
  const fromMs = toMs - config.days * MS_PER_DAY;
  const scenarios = presetScenarios(config.scenario, config.sites, { fromMs, toMs });
  console.log(
    `[backfill] ${formatKst(fromMs)} ~ ${formatKst(toMs)} · ${config.sites.join(',')} · 시나리오 ${config.scenario} · 시드 ${config.seed} · ` +
      `배치 ${config.batchMinutes}분(최대 ${formatCount(config.maxSamples)} 샘플) · 동시성 ${config.concurrency} → ${config.baseUrl}`,
  );

  const emitter = createHttpEmitter({ baseUrl: config.baseUrl, credentials });
  const report = progressReporter(fromMs, toMs, startedAt);
  const source = simulate({
    siteCodes: config.sites,
    from: fromMs,
    to: toMs,
    seed: config.seed,
    scenarios,
    batchPeriodS: config.batchMinutes * 60,
    maxSamplesPerBatch: config.maxSamples,
    serverNowMs: startedAt,
  });
  const summary = await runBatches(source, {
    concurrency: config.concurrency,
    emit: (batch) => emitter.emit(batch),
    maxFailures: DEFAULT_MAX_FAILURES,
    onResult: (current, batch) => report(current, batch.sentAtMs),
  });
  const elapsedMs = Date.now() - startedAt;
  report(summary, toMs, true);
  printSummary(summary, elapsedMs);

  writeManifest(config.manifestPath, {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    seed: config.seed,
    scenario: config.scenario,
    sites: [...config.sites],
    fromMs,
    toMs,
    batchMinutes: config.batchMinutes,
    maxSamplesPerBatch: config.maxSamples,
    concurrency: config.concurrency,
    elapsedMs,
    summary,
  });
  if (summary.aborted || summary.results.failed > 0) {
    console.error(`[backfill] 실패한 배치가 있어 중단했거나 일부가 빠졌습니다${summary.aborted ? ` (실패 ${DEFAULT_MAX_FAILURES}건에서 중단)` : ''}.`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[backfill] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
