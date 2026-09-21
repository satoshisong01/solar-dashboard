// 사이트 잡 하나: (1) 준비 — 메모리 모드 시뮬레이션 → 설비별 에피소드 추출(분석 파이프라인과 같은 함수) + 참 SOH 요약 + 데이터 품질 압축 요약
//   + P3 보조 입력(정지 구간 원시 점·열 저감 표본·정류기 효율·체인 원장, prepare-p3.ts)
// (2) 평가 — 주 단위 점검 시각마다 탐지기 14종 실행, 주입 고장은 하루 단위로 첫 탐지 시각을 좁힌다.
// 준비 결과는 JSON으로 저장할 수 있어 탐지기 파라미터만 바꿔 다시 평가할 때 시뮬레이션을 건너뛸 수 있다.
import { dqGapFlatline } from '@/lib/analytics/detectors/dq-gap-flatline';
import { codeDefaultConfigRef } from '@/lib/analytics/pipeline/config';
import { runSiteDetectors } from '@/lib/analytics/pipeline/detect';
import { extractAssetEpisodes } from '@/lib/analytics/pipeline/extract';
import { indexSnapshot, type SnapshotIndex } from '@/lib/analytics/pipeline/snapshot';
import { seriesRequests } from '@/lib/analytics/pipeline/sources';
import type { DetectorConfigRow, DetectorOutcome, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/analytics/types';
import { detectorPointFilter, gapyeongDetectorPointFilter, p3DetectorPointFilter, simulateMemory, type MemoryPoint, type MemorySeries } from '../memory';
import type { SimulationTruth } from '../truth';
import { assetEventsOf, evalSite, type EvalSite } from './assets';
import type { SiteJob } from './jobs';
import { dqAssetCount, dqFindingsAt, prepareDq, type PreparedDq } from './dq';
import { injectionResults, relatedWindowsOf, type InjectionContext } from './injections';
import { assetSeriesFor } from './memory-series';
import { auxAt, prepareP3, type PreparedP3 } from './prepare-p3';
import { detectionOf, tallyOutcomes } from './records';
import { EVAL_DETECTOR_CLASS, EVAL_DETECTOR_IDS, SITE_SCOPED_DETECTORS, type CheckpointStatus, type EvalDetectorId, type LedgerResidualDay, type SiteJobResult } from './types';

/** 랙 경로 → 시간 평균 참 SOH [ts, soh] (용량 탐지 크기 참값용. 탐지기에는 넘기지 않는다) */
export type HourlySoh = Readonly<Record<string, readonly (readonly [ts: number, soh: number])[]>>;

export interface PreparedJob {
  readonly job: SiteJob;
  readonly fromMs: number;
  readonly toMs: number;
  readonly episodes: readonly StoredEpisode[];
  readonly truth: SimulationTruth;
  readonly soh: HourlySoh;
  readonly dq: PreparedDq;
  readonly p3: PreparedP3;
  readonly stats: { readonly simulationMs: number; readonly extractionMs: number; readonly samples: number };
}

/** 준비 결과 형식 버전 (캐시 키에 넣는다: 형식이 바뀌면 예전 캐시를 쓰지 않는다) */
export const PREPARED_JOB_FORMAT = 4;

export interface EvaluateOptions {
  /** 첫 점검일 (기준선 세션이 쌓일 시간) */
  readonly firstCheckpointDay?: number;
  readonly checkpointStepDays?: number;
  readonly configs?: readonly DetectorConfigRow[];
  /** 평가할 탐지기 (기본 14종) */
  readonly detectorIds?: readonly EvalDetectorId[];
  readonly now?: () => number;
}

const DEFAULT_FIRST_CHECKPOINT_DAY = 28;
const DEFAULT_STEP_DAYS = 7;

/** 원장이 읽는 전력 계량 포인트 (P2·P3 탐지기 목록에 없는 PCS·계통 계량기) */
const LEDGER_EXTRA: Readonly<Record<string, readonly string[]>> = { 'ess.pcs': ['ac.power'], 'grid.meter': ['ac.power'] };

const pointFilter = (point: MemoryPoint): boolean =>
  detectorPointFilter(point) || p3DetectorPointFilter(point) || gapyeongDetectorPointFilter(point) || (LEDGER_EXTRA[point.classKey]?.includes(point.metricKey) ?? false) || (point.classKey === 'ess.rack' && point.metricKey === 'batt.soh');

function extractAll(site: EvalSite, memory: ReadonlyMap<string, MemorySeries>, window: { start: number; end: number }): StoredEpisode[] {
  const assetById = new Map(site.assets.map((a) => [a.id, a]));
  return site.assets.flatMap((asset) => {
    const requests = seriesRequests(asset, site.assets);
    return requests.length === 0 ? [] : extractAssetEpisodes(asset, assetSeriesFor(requests, assetById, site.site.code, memory), window);
  });
}

function hourlySoh(memory: ReadonlyMap<string, MemorySeries>): HourlySoh {
  const entries = [...memory.values()]
    .filter((s) => s.metricKey === 'batt.soh')
    .map((s) => {
      const buckets = new Map<number, { sum: number; n: number }>();
      s.ts.forEach((ts, i) => {
        const hour = Math.floor(ts / MS_PER_HOUR) * MS_PER_HOUR;
        const bucket = buckets.get(hour) ?? { sum: 0, n: 0 };
        buckets.set(hour, { sum: bucket.sum + (s.value[i] as number), n: bucket.n + 1 });
      });
      return [s.assetPath, [...buckets.entries()].map(([ts, b]) => [ts, b.sum / b.n] as const)] as const;
    });
  return Object.fromEntries(entries);
}

export function prepareSiteJob(job: SiteJob, now: () => number = () => performance.now()): PreparedJob {
  const site = evalSite(job.siteCode);
  const fromMs = Date.parse(job.from);
  const toMs = fromMs + job.days * MS_PER_DAY;
  const window = { start: fromMs, end: toMs };
  const simulated = simulateMemory({ siteCodes: [job.siteCode], from: fromMs, to: toMs, seed: job.seed, scenarios: job.scenarios, pointFilter, now });
  const started = now();
  const episodes = extractAll(site, simulated.series, window);
  return {
    job,
    fromMs,
    toMs,
    episodes,
    truth: simulated.truth,
    soh: hourlySoh(simulated.series),
    dq: prepareDq(site, simulated.series, window),
    p3: prepareP3(site, simulated.series, window, episodes),
    stats: { simulationMs: simulated.stats.elapsedMs, extractionMs: now() - started, samples: simulated.stats.samples },
  };
}

function checkpoints(fromMs: number, days: number, options: EvaluateOptions): number[] {
  const first = options.firstCheckpointDay ?? DEFAULT_FIRST_CHECKPOINT_DAY;
  const step = options.checkpointStepDays ?? DEFAULT_STEP_DAYS;
  const list = Array.from({ length: Math.max(0, Math.floor((days - first) / step) + 1) }, (_, i) => fromMs + (first + i * step) * MS_PER_DAY);
  const end = fromMs + days * MS_PER_DAY;
  return list.at(-1) === end ? list : [...list, end];
}

/** dq.gap_flatline은 스냅샷 대신 메모리 요약으로 실행한다 (사이트 단위 결과 하나) */
function dqOutcome(prepared: PreparedJob, siteId: number, now: number): DetectorOutcome {
  const findings = dqFindingsAt(prepared.dq, siteId, prepared.fromMs, now, prepared.job.seed);
  return { detectorId: 'dq.gap_flatline', detectorVersion: '1', siteId, assetId: null, status: 'ok', findings, reason: null, configVersions: [], config: codeDefaultConfigRef(dqGapFlatline.defaultParams) };
}

/** 점검 시각의 탐지 결과. 스냅샷 색인은 한 번만 만들고 시각마다 보조 입력(열 저감 표본 창)만 바꾼다 */
export function outcomesAt(index: SnapshotIndex, prepared: PreparedJob, now: number, detectorIds: readonly EvalDetectorId[], targetAssetIds?: ReadonlySet<number>): DetectorOutcome[] {
  const pipelineIds = detectorIds.filter((id) => id !== 'dq.gap_flatline');
  const checkpointIndex: SnapshotIndex = { ...index, snapshot: { ...index.snapshot, aux: auxAt(prepared.p3, now) } };
  const pipeline = pipelineIds.length === 0 ? [] : runSiteDetectors(checkpointIndex, { now, seed: prepared.job.seed, detectorIds: pipelineIds, targetAssetIds });
  return detectorIds.includes('dq.gap_flatline') ? [...pipeline, dqOutcome(prepared, index.snapshot.siteId, now)] : pipeline;
}

function capacityStatusesOf(runs: readonly { readonly now: number; readonly outcomes: readonly DetectorOutcome[] }[]): CheckpointStatus[] {
  return runs.flatMap(({ now, outcomes }) => outcomes.flatMap((o) => (o.detectorId === 'ess.capacity_fade' && o.assetId !== null ? [{ ts: now, assetId: o.assetId, status: o.status }] : [])));
}

function applicableOf(index: SnapshotIndex, prepared: PreparedJob, id: EvalDetectorId): number {
  if (id === 'dq.gap_flatline') return dqAssetCount(prepared.dq);
  const count = index.assetsOfClass(EVAL_DETECTOR_CLASS[id]).length;
  return SITE_SCOPED_DETECTORS.has(id) ? Math.min(1, count) : count;
}

const ledgerResidualsOf = (prepared: PreparedJob): LedgerResidualDay[] =>
  prepared.p3.ledgerDays.map((d) => ({ day: d.dayStart, residualPct: d.h2.residual_pct, completeness: d.h2Completeness, producedKg: d.h2.produced }));

export { relatedWindowsOf } from './injections';

export function evaluatePreparedJob(prepared: PreparedJob, options: EvaluateOptions = {}): SiteJobResult {
  const clock = options.now ?? (() => performance.now());
  const { job } = prepared;
  const site = evalSite(job.siteCode);
  const index = indexSnapshot({ siteId: site.siteId, assets: site.assets, episodes: prepared.episodes, events: assetEventsOf(site, prepared.truth.assetEvents), configs: options.configs ?? [] });
  const started = clock();
  const checkpointTs = checkpoints(prepared.fromMs, job.days, options);
  const detectorIds = options.detectorIds ?? EVAL_DETECTOR_IDS;
  const runs = checkpointTs.map((now) => ({ now, outcomes: outcomesAt(index, prepared, now, detectorIds) }));
  const detections = runs.flatMap(({ now, outcomes }) => detectionOf(outcomes, now));
  const ctx: InjectionContext = { site, detections, soh: prepared.soh, outcomesAt: (now, ids, targets) => outcomesAt(index, prepared, now, ids, targets) };
  const injections = injectionResults(ctx, prepared.truth.injections).filter((i) => (detectorIds as readonly string[]).includes(i.detectorId));
  return {
    jobId: job.id,
    seed: job.seed,
    siteCode: job.siteCode,
    runIds: job.runIds,
    fromMs: prepared.fromMs,
    toMs: prepared.toMs,
    checkpointTs,
    applicableAssets: Object.fromEntries(EVAL_DETECTOR_IDS.map((id) => [id, applicableOf(index, prepared, id)])),
    detections,
    injections,
    related: relatedWindowsOf(site, prepared.truth.injections),
    controls: prepared.truth.controls,
    tallies: tallyOutcomes(runs.flatMap((r) => r.outcomes)),
    capacityStatuses: capacityStatusesOf(runs),
    ledgerResiduals: ledgerResidualsOf(prepared),
    stats: { ...prepared.stats, detectionMs: clock() - started, episodes: prepared.episodes.length },
  };
}

export const replaySiteJob = (job: SiteJob, options: EvaluateOptions = {}): SiteJobResult => evaluatePreparedJob(prepareSiteJob(job, options.now), options);
