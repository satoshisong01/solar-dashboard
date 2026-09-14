// 사이트 잡 하나: (1) 준비 — 메모리 모드 시뮬레이션 → 설비별 에피소드 추출(분석 파이프라인과 같은 함수) + 참 SOH 요약
// (2) 평가 — 주 단위 점검 시각마다 탐지기 실행, 주입 고장은 하루 단위로 첫 탐지 시각을 좁힌다.
// 준비 결과는 JSON으로 저장할 수 있어 탐지기 파라미터만 바꿔 다시 평가할 때 시뮬레이션을 건너뛸 수 있다.
import { runSiteDetectors } from '@/lib/analytics/pipeline/detect';
import { extractAssetEpisodes } from '@/lib/analytics/pipeline/extract';
import { indexSnapshot, type SnapshotIndex } from '@/lib/analytics/pipeline/snapshot';
import { seriesRequests } from '@/lib/analytics/pipeline/sources';
import type { DetectorConfigRow, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/analytics/types';
import { detectorPointFilter, simulateMemory, type MemoryPoint, type MemorySeries } from '../memory';
import type { SimulationTruth, InjectionTruth } from '../truth';
import { assetEventsOf, evalSite, type EvalSite } from './assets';
import type { SiteJob } from './jobs';
import { assetSeriesFor } from './memory-series';
import { detectionOf, injectionMagnitude, isEvalDetector, tallyOutcomes } from './records';
import { EVAL_DETECTOR_CLASS, EVAL_DETECTOR_IDS, type DetectionRecord, type EvalDetectorId, type InjectionResult, type SiteJobResult } from './types';

/** 랙 경로 → 시간 평균 참 SOH [ts, soh] (용량 탐지 크기 참값용. 탐지기에는 넘기지 않는다) */
export type HourlySoh = Readonly<Record<string, readonly (readonly [ts: number, soh: number])[]>>;

export interface PreparedJob {
  readonly job: SiteJob;
  readonly fromMs: number;
  readonly toMs: number;
  readonly episodes: readonly StoredEpisode[];
  readonly truth: SimulationTruth;
  readonly soh: HourlySoh;
  readonly stats: { readonly simulationMs: number; readonly extractionMs: number; readonly samples: number };
}

export interface EvaluateOptions {
  /** 첫 점검일 (기준선 세션이 쌓일 시간) */
  readonly firstCheckpointDay?: number;
  readonly checkpointStepDays?: number;
  readonly configs?: readonly DetectorConfigRow[];
  /** 평가할 탐지기 (기본 메모리 모드 5종) */
  readonly detectorIds?: readonly EvalDetectorId[];
  readonly now?: () => number;
}

const DEFAULT_FIRST_CHECKPOINT_DAY = 28;
const DEFAULT_STEP_DAYS = 7;

const pointFilter = (point: MemoryPoint): boolean => detectorPointFilter(point) || (point.classKey === 'ess.rack' && point.metricKey === 'batt.soh');

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
  const simulated = simulateMemory({ siteCodes: [job.siteCode], from: fromMs, to: toMs, seed: job.seed, scenarios: job.scenarios, pointFilter, now });
  const started = now();
  const episodes = extractAll(site, simulated.series, { start: fromMs, end: toMs });
  return {
    job,
    fromMs,
    toMs,
    episodes,
    truth: simulated.truth,
    soh: hourlySoh(simulated.series),
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

interface InjectionContext {
  readonly index: SnapshotIndex;
  readonly prepared: PreparedJob;
  readonly site: EvalSite;
  readonly detections: readonly DetectionRecord[];
}

function firstDetection(ctx: InjectionContext, detectorId: EvalDetectorId, assetId: number, failureModes: readonly string[], range: { from: number; to: number }): number | null {
  for (let now = range.from; now <= range.to; now += MS_PER_DAY) {
    const outcomes = runSiteDetectors(ctx.index, { now, seed: ctx.prepared.job.seed, detectorIds: [detectorId], targetAssetIds: new Set([assetId]) });
    if (outcomes.some((o) => o.findings.some((f) => f.assetId === assetId && failureModes.includes(f.failureMode)))) return now;
  }
  return null;
}

function windowMean(points: readonly (readonly [number, number])[] | undefined, from: number, to: number): number | null {
  const inside = (points ?? []).filter(([ts]) => ts >= from && ts <= to);
  return inside.length === 0 ? null : inside.reduce((sum, [, v]) => sum + v, 0) / inside.length;
}

function trueEffectOf(ctx: InjectionContext, detectorId: EvalDetectorId, assetPath: string, magnitude: number, last: DetectionRecord | undefined): number | null {
  if (detectorId === 'el.voltage_rise' || detectorId === 'fc.voltage_decay') return magnitude;
  if (detectorId === 'pv.inverter_peer') return -magnitude;
  if (detectorId !== 'ess.capacity_fade' || !last?.windows) return null;
  const soh = ctx.prepared.soh[assetPath];
  const reference = windowMean(soh, last.windows.referenceFrom, last.windows.referenceTo);
  const recent = windowMean(soh, last.windows.recentFrom, last.windows.recentTo);
  return reference === null || recent === null || reference === 0 ? null : (recent / reference - 1) * 100;
}

function injectionResults(ctx: InjectionContext, injection: InjectionTruth): InjectionResult[] {
  const asset = injection.assetPath === null ? undefined : ctx.site.byPath.get(injection.assetPath);
  if (!asset || injection.assetPath === null) return [];
  const assetPath = injection.assetPath;
  return injection.expectedDetectors.filter(isEvalDetector).map((detectorId) => {
    const { magnitude, unit } = injectionMagnitude(injection);
    const own = ctx.detections.filter((d) => d.detectorId === detectorId && d.assetId === asset.id && injection.expectedFailureModes.includes(d.failureMode) && d.ts >= injection.startTs);
    const firstWeekly = own[0];
    const firstDetectionTs = firstWeekly ? firstDetection(ctx, detectorId, asset.id, injection.expectedFailureModes, { from: Math.max(injection.startTs, firstWeekly.ts - 6 * MS_PER_DAY), to: firstWeekly.ts }) : null;
    const last = own.at(-1);
    return { injection, detectorId, assetId: asset.id, magnitude, unit, firstDetectionTs, finalEffect: last?.effect ?? null, trueEffect: trueEffectOf(ctx, detectorId, assetPath, magnitude, last) };
  });
}

export function evaluatePreparedJob(prepared: PreparedJob, options: EvaluateOptions = {}): SiteJobResult {
  const clock = options.now ?? (() => performance.now());
  const { job } = prepared;
  const site = evalSite(job.siteCode);
  const index = indexSnapshot({ siteId: site.siteId, assets: site.assets, episodes: prepared.episodes, events: assetEventsOf(site, prepared.truth.assetEvents), configs: options.configs ?? [] });
  const started = clock();
  const checkpointTs = checkpoints(prepared.fromMs, job.days, options);
  const detectorIds = options.detectorIds ?? EVAL_DETECTOR_IDS;
  const runs = checkpointTs.map((now) => ({ now, outcomes: runSiteDetectors(index, { now, seed: job.seed, detectorIds }) }));
  const detections = runs.flatMap(({ now, outcomes }) => detectionOf(outcomes, now));
  const ctx: InjectionContext = { index, prepared, site, detections };
  const injections = prepared.truth.injections.flatMap((injection) => injectionResults(ctx, injection)).filter((i) => (detectorIds as readonly string[]).includes(i.detectorId));
  return {
    jobId: job.id,
    seed: job.seed,
    siteCode: job.siteCode,
    runIds: job.runIds,
    fromMs: prepared.fromMs,
    toMs: prepared.toMs,
    checkpointTs,
    applicableAssets: Object.fromEntries(EVAL_DETECTOR_IDS.map((id) => [id, index.assetsOfClass(EVAL_DETECTOR_CLASS[id]).length])),
    detections,
    injections,
    controls: prepared.truth.controls,
    tallies: tallyOutcomes(runs.flatMap((r) => r.outcomes)),
    stats: { ...prepared.stats, detectionMs: clock() - started, episodes: prepared.episodes.length },
  };
}

export const replaySiteJob = (job: SiteJob, options: EvaluateOptions = {}): SiteJobResult => evaluatePreparedJob(prepareSiteJob(job, options.now), options);
