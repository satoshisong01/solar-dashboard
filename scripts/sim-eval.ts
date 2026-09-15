// 시뮬레이터 평가 게이트 (npm run sim:eval, 설계 §5.5):
//   메모리 모드 eval 프리셋(1년 × 3사이트 × 시드 3 × 크기 스윕)으로 데이터를 만들고, 분석 파이프라인과 같은 추출·탐지 함수를
//   주 단위 점검 시각마다 돌려 재현율·정밀도·자산월당 오탐·탐지 지연·크기 오차·최소 탐지 크기 곡선을 계산한다.
//   게이트 미달이면 종료 코드 1. 전체 프리셋이면 lib/analytics/scorecard.json을 갱신하고, 로컬 DB가 떠 있으면 sim.eval_result에 기록한다.
//
//   npm run sim:eval                                  전체 (시드 3 × 스윕 5)
//   npm run sim:eval -- --runs 3,4,5                  CI 축소: 스윕 3~5번(용량 5·7·10%, 전해조 20·40 µV/h)만 — 용량·스택 게이트 주입은 전체와 같고 셀 불균형·데이터 품질은 가장 큰 크기만
//   npm run sim:eval -- --cache .data/sim-eval        시뮬레이션·추출 결과를 저장해 탐지기 파라미터만 바꿔 다시 평가
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { r } from '../lib/analytics/detectors/common';
import { kstDateString } from '../lib/analytics/types';
import { buildSslOptions } from '../lib/db/pool';
import type { DB } from '../lib/db/types';
import { parseDatabaseEnv } from '../lib/env';
import { selectPlans, siteJobs } from '../lib/sim/eval/jobs';
import { runJobsInPool } from '../lib/sim/eval/pool';
import { buildScorecard } from '../lib/sim/eval/scorecard';
import { scoreAll } from '../lib/sim/eval/score';
import { recordEvaluation } from '../lib/sim/eval/store';
import type { SiteJobResult } from '../lib/sim/eval/types';
import { EVAL_PRESET, evalRunPlans } from '../lib/sim/presets';
import { assertLocalDatabaseUrl, isPortOpen, LOCAL_PG } from './local-pg';
import { formatDuration } from './sim-shared';

const DEFAULT_SCORECARD = 'lib/analytics/scorecard.json';

/** 게이트를 통과하도록 조정한 탐지기 파라미터 설명 (스코어카드에 함께 남긴다) */
const PARAMS_NOTE: Readonly<Record<string, string>> = {
  'ess.capacity_fade':
    '시뮬레이터 EMS가 SOC 90%에서 충전을 멈춰 앵커(CV 종료)·CC 보조 세션이 없으므로 부분 충전 쿨롱 카운팅 용량(capacity_ah_soc = 충전 Ah ÷ SOC 변화, SOC 변화 40% 이상) 보조 지표를 추가. ' +
    '5% 이상 탐지 지연 중앙값 23일 → 19일: recentDays 30 → 21, minPerBin 5 → 3 (minTotal 15·심각도 임계 −3/−5/−10%·CI 상한 < 0 조건은 그대로). ' +
    'C-rate·셀 온도 bin 폭을 탐지기 설정(cRateBinWidth 0.05·tempBinWidthC 5, 값은 그대로)으로 옮겨 재추출 없이 조정 가능. ' +
    'P2 보강: 첫 20 세션 전체 기준 → bin별 기준(referencePerBin 5, 주 bin 기준 시점과 maxReferenceSpreadDays 120일 넘게 떨어진 bin 제외, 최근 합계 15는 그대로·기준 합계는 bin당 5). ' +
    '휴지 앵커 방식(rest_anchored: 30분 이상 휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC, |ΔSOC| ≥ 25%, 가중치 = 1/상대분산[SOC 1σ 1%p·전류 적분 0.5%])을 앵커 다음 순위로 추가하고 matchedRatio를 가중 중앙값·최근 가중치 결합으로 확장. ' +
    '연계형(SIM-B) 판정 불능 약 95% → 0%, 여름 연속 판정 불능 약 5개월 → 0일. 심각도 임계·CI 조건·recentDays·minPerBin은 그대로.',
  'fc.voltage_decay':
    '정출력 운전에서 전압이 떨어지면 전류밀도·온도가 함께 올라 bin 안 회귀 보정이 열화를 지워 20·40 µV/h를 0/6 탐지. ' +
    'correctCurrentDensity·correctTemperature = false(전류밀도 bin·회귀 끔, 온도 bin 유지), 전압은 v_cell_at_jref만 사용(v_cell_mean 대체 제거). ' +
    '추출기 기준 전류밀도 0.5 → 0.6 A/cm², 분극 기울기 0.25 → 0.2 V/(A/cm²), 환산 허용 거리 0.25 → 0.3. 심각도 임계(10/20/40 µV/h)는 그대로. ' +
    'P2 보강: el.voltage_rise와 같은 변화점 이후 기울기 규칙(minHoursAfterChange 300 h, 변화 전·후 CI 분리).',
  'el.voltage_rise':
    'break-in 1,000 h 이후만 쓰므로 1년 평가에서 탐지 지연이 김. P2 보강: CUSUM 변화 시작점 뒤 누적 운전시간 300 h 이상이고 변화 전·후 기울기 95% CI가 겹치지 않으면 변화점 이후 기울기를 효과로 사용(기울기가 일정하면 전체 기울기 유지). 심각도 임계·CI 조건은 그대로.',
  'pv.inverter_peer':
    '동종 4대에서는 MAD가 거의 항상 하한이라 하한이 곧 임계다. madFloorRatio 0.5% → 0.3%(수정 z −3.5 기준 유효 탐지 편차 약 2.6% → 1.6%)로 인버터 2%p 저하 0/3 → 3/3, 1%p는 0/3 그대로, 대조군(흐린 주·출력제어) 포함 오탐 0. z 임계 −3.5·최근 7일 중 5일 조건은 그대로.',
  'dq.gap_flatline':
    '탐지기 변경 없음. 메모리 모드에 저장값 수준 결측(dq.sample_loss: 샘플 제거)·고착(dq.stuck_sensor: 값 고정) 주입(3·6·12시간)을 넣고 DB 경로와 같은 요약 규칙(lib/analytics/dq/summary.ts)으로 주 단위 7일 창을 평가. ' +
    '고착 구간 끝을 마지막 샘플 + 주기로 바꿔(6시간 고착이 샘플 간격만큼 짧게 재지던 문제) 6시간 기준에서 빠지지 않게 하고, 일사량 metric_def에 고착 기준 2시간·야간 |값| ≤ 5 W/m² 제외 규칙 추가. ' +
    '전송 계층 단절 후 백필·지연·시계 오차는 메모리 모드가 재현하지 않아 DB E2E 모드에서 확인.',
  'ess.cell_imbalance': '탐지기 변경 없음. eval 프리셋에 SIM-A 랙 3 셀 전압 산포 증가 주입(월 5·10·20 mV, 120일째 시작)을 추가해 재현율도 평가.',
};

interface EvalConfig {
  readonly seeds: readonly number[];
  readonly runs: readonly number[] | null;
  readonly concurrency: number;
  readonly out: string | null;
  readonly cacheDir: string | null;
  readonly useDb: boolean;
}

function parseList(name: string, raw: string | undefined): number[] | null {
  if (raw === undefined) return null;
  const values = raw.split(',').map((v) => Number(v.trim()));
  if (values.length === 0 || values.some((v) => !Number.isSafeInteger(v) || v < 0)) throw new Error(`--${name}은(는) 쉼표로 구분한 0 이상의 정수 목록이어야 합니다 (받은 값: ${raw})`);
  return values;
}

function readConfig(): EvalConfig {
  const { values } = parseArgs({
    options: {
      seeds: { type: 'string' },
      runs: { type: 'string' },
      concurrency: { type: 'string' },
      out: { type: 'string' },
      cache: { type: 'string' },
      'no-db': { type: 'boolean', default: false },
    },
  });
  const seeds = parseList('seeds', values.seeds) ?? [...EVAL_PRESET.seeds];
  const runs = parseList('runs', values.runs);
  const partial = values.seeds !== undefined || runs !== null;
  const concurrency = values.concurrency === undefined ? Math.max(1, Math.min(8, availableParallelism() - 1)) : Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error(`--concurrency는 1~32 정수여야 합니다 (받은 값: ${values.concurrency})`);
  return {
    seeds,
    runs,
    concurrency,
    // 일부만 돌리면 커밋한 스코어카드를 덮어쓰지 않는다 (--out을 직접 주면 쓴다)
    out: values.out !== undefined ? resolve(process.cwd(), values.out) : partial ? null : resolve(process.cwd(), DEFAULT_SCORECARD),
    cacheDir: values.cache === undefined ? null : resolve(process.cwd(), values.cache),
    useDb: !values['no-db'],
  };
}

const fmt = (value: number | null, digits = 2): string => (value === null ? '-' : String(r(value, digits)));

function printScores(jobs: readonly SiteJobResult[]): void {
  console.log('[sim:eval] 탐지기          TP  FP  FN  재현율  정밀도  오탐/자산월  지연중앙[일]  크기MAE  최소탐지크기');
  for (const s of scoreAll(jobs)) {
    console.log(
      `[sim:eval] ${s.detectorId.padEnd(18)} ${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ${String(s.fn).padStart(3)}  ${fmt(s.recall).padStart(5)}  ${fmt(s.precision).padStart(5)}  ${fmt(s.fpPerAssetMonth, 3).padStart(10)}  ${fmt(s.medianDelayDays, 1).padStart(11)}  ${fmt(s.magnitudeMae, 2).padStart(7)}  ${s.minDetectableMagnitude ?? '-'} ${s.unit ?? ''}`,
    );
    console.log(`[sim:eval]     크기별: ${s.curve.map((p) => `${p.magnitude}${s.unit ?? ''} ${p.detected}/${p.injections}${p.medianDelayDays === null ? '' : ` ${fmt(p.medianDelayDays, 0)}일`}`).join(' · ') || '(주입 없음)'}`);
  }
}

async function recordToDb(scorecard: ReturnType<typeof buildScorecard>, jobs: readonly SiteJobResult[]): Promise<void> {
  if (!process.env.DATABASE_URL) return console.log('[sim:eval] DATABASE_URL이 없어 sim.eval_result 기록을 건너뜁니다');
  const env = parseDatabaseEnv();
  assertLocalDatabaseUrl(env.DATABASE_URL);
  if (!(await isPortOpen(LOCAL_PG.port, LOCAL_PG.host))) return console.log('[sim:eval] 로컬 DB가 꺼져 있어 sim.eval_result 기록을 건너뜁니다 (npm run db:up)');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: env.DATABASE_URL, ssl: buildSslOptions(env), max: 2 }) }) });
  try {
    const runId = await recordEvaluation(db, scorecard, jobs, scoreAll(jobs));
    console.log(`[sim:eval] sim.run ${runId}에 평가 결과를 기록했습니다`);
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const started = Date.now();
  const jobs = siteJobs(selectPlans(evalRunPlans(), { seeds: config.seeds, runs: config.runs ?? undefined }));
  if (jobs.length === 0) throw new Error('선택한 시드·순번에 해당하는 평가 잡이 없습니다');
  console.log(`[sim:eval] 사이트 잡 ${jobs.length}개 · 시드 ${config.seeds.join(',')} · 순번 ${config.runs?.join(',') ?? '전체'} · 동시 ${config.concurrency} · ${EVAL_PRESET.days}일${config.cacheDir ? ` · 캐시 ${config.cacheDir}` : ''}`);

  const responses = await runJobsInPool(jobs, {
    workerScript: resolve(__dirname, 'sim-eval-worker.ts'),
    concurrency: config.concurrency,
    cacheDir: config.cacheDir,
    onResult: (response, done, total) => {
      const detail = response.kind === 'result' ? `${formatDuration(response.result.stats.simulationMs + response.result.stats.extractionMs + response.result.stats.detectionMs)}${response.cached ? ' (캐시)' : ''}` : `실패: ${response.message.split('\n')[0]}`;
      console.log(`[sim:eval] ${done}/${total} ${response.jobId} ${detail} · 경과 ${formatDuration(Date.now() - started)}`);
    },
  });
  const failures = responses.filter((r) => r.kind === 'error');
  if (failures.length > 0) {
    failures.forEach((f) => console.error(`[sim:eval] ${f.jobId} 실패\n${f.message}`));
    throw new Error(`평가 잡 ${failures.length}개가 실패했습니다`);
  }
  const results = responses.flatMap((r) => (r.kind === 'result' ? [r.result] : []));
  const elapsedMs = Date.now() - started;
  const scorecard = buildScorecard(results, { preset: EVAL_PRESET, seeds: config.seeds, runs: config.runs, generatedAt: kstDateString(Date.now()), elapsedMs, paramsNote: PARAMS_NOTE });

  printScores(results);
  for (const g of scorecard.gates) console.log(`[sim:eval] ${g.pass ? '통과' : '실패'} ${g.description}: ${fmt(g.value, 3)} (기준 ${g.comparator} ${g.threshold})`);
  if (config.out) {
    mkdirSync(dirname(config.out), { recursive: true });
    writeFileSync(config.out, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
    console.log(`[sim:eval] 스코어카드: ${config.out}`);
  }
  if (config.useDb) await recordToDb(scorecard, results).catch((error: unknown) => console.warn(`[sim:eval] sim.eval_result 기록 실패: ${error instanceof Error ? error.message : String(error)}`));
  console.log(`[sim:eval] ${scorecard.pass ? '게이트 통과' : '게이트 미달'} · 총 ${formatDuration(elapsedMs)}`);
  if (!scorecard.pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[sim:eval] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
