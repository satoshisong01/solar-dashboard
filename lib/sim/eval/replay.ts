// 사이트 잡 하나: (1) 준비 — 메모리 모드 시뮬레이션 → 설비별 에피소드 추출(분석 파이프라인과 같은 함수) + 참 SOH 요약 + 데이터 품질 압축 요약
// (2) 평가 — 주 단위 점검 시각마다 탐지기 실행, 주입 고장은 하루 단위로 첫 탐지 시각을 좁힌다.
// 준비 결과는 JSON으로 저장할 수 있어 탐지기 파라미터만 바꿔 다시 평가할 때 시뮬레이션을 건너뛸 수 있다.
import { dqGapFlatline } from '@/lib/analytics/detectors/dq-gap-flatline';
import { codeDefaultConfigRef } from '@/lib/analytics/pipeline/config';
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
import { dqAssetCount, dqFindingsAt, prepareDq, type PreparedDq } from './dq';
import { assetSeriesFor } from './memory-series';
import { detectionOf, injectionMagnitude, isEvalDetector, tallyOutcomes } from './records';
import type { DetectorOutcome } from '@/lib/analytics/pipeline/types';
import { EVAL_DETECTOR_CLASS, EVAL_DETECTOR_IDS, type CheckpointStatus, type DetectionRecord, type EvalDetectorId, type EvidenceWindows, type InjectionResult, type RelatedWindow, type SiteJobResult } from './types';

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
  readonly stats: { readonly simulationMs: number; readonly extractionMs: number; readonly samples: number };
}

/** 준비 결과 형식 버전 (캐시 키에 넣는다: 형식이 바뀌면 예전 캐시를 쓰지 않는다) */
export const PREPARED_JOB_FORMAT = 2;

export interface EvaluateOptions {
  /** 첫 점검일 (기준선 세션이 쌓일 시간) */
  readonly firstCheckpointDay?: number;
  readonly checkpointStepDays?: number;
  readonly configs?: readonly DetectorConfigRow[];
  /** 평가할 탐지기 (기본 메모리 모드 6종) */
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
    dq: prepareDq(site, simulated.series, { start: fromMs, end: toMs }),
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

/** dq.gap_flatline은 스냅샷 대신 메모리 요약으로 실행한다 (사이트 단위 결과 하나) */
function dqOutcome(prepared: PreparedJob, siteId: number, now: number): DetectorOutcome {
  const findings = dqFindingsAt(prepared.dq, siteId, prepared.fromMs, now, prepared.job.seed);
  return { detectorId: 'dq.gap_flatline', detectorVersion: '1', siteId, assetId: null, status: 'ok', findings, reason: null, configVersions: [], config: codeDefaultConfigRef(dqGapFlatline.defaultParams) };
}

function outcomesAt(index: SnapshotIndex, prepared: PreparedJob, now: number, detectorIds: readonly EvalDetectorId[], targetAssetIds?: ReadonlySet<number>): DetectorOutcome[] {
  const pipelineIds = detectorIds.filter((id) => id !== 'dq.gap_flatline');
  const pipeline = pipelineIds.length === 0 ? [] : runSiteDetectors(index, { now, seed: prepared.job.seed, detectorIds: pipelineIds, targetAssetIds });
  return detectorIds.includes('dq.gap_flatline') ? [...pipeline, dqOutcome(prepared, index.snapshot.siteId, now)] : pipeline;
}

function firstDetection(ctx: InjectionContext, detectorId: EvalDetectorId, assetId: number, failureModes: readonly string[], range: { from: number; to: number }): number | null {
  for (let now = range.from; now <= range.to; now += MS_PER_DAY) {
    const outcomes = outcomesAt(ctx.index, ctx.prepared, now, [detectorId], new Set([assetId]));
    if (outcomes.some((o) => o.findings.some((f) => f.assetId === assetId && failureModes.includes(f.failureMode)))) return now;
  }
  return null;
}

function windowMean(points: readonly (readonly [number, number])[] | undefined, from: number, to: number): number | null {
  const inside = (points ?? []).filter(([ts]) => ts >= from && ts <= to);
  return inside.length === 0 ? null : inside.reduce((sum, [, v]) => sum + v, 0) / inside.length;
}

/** 참 SOH 비율 변화 [%]. bin별 기준이면 bin마다 (최근 기간 평균 ÷ 기준 기간 평균)을 결합 가중치로 합친다 (탐지기 추정과 같은 정의) */
function trueCapacityEffect(soh: readonly (readonly [number, number])[] | undefined, windows: EvidenceWindows): number | null {
  const ratio = (refFrom: number, refTo: number, curFrom: number, curTo: number): number | null => {
    const reference = windowMean(soh, refFrom, refTo);
    const recent = windowMean(soh, curFrom, curTo);
    return reference === null || recent === null || reference === 0 ? null : recent / reference;
  };
  if (windows.bins.length === 0) {
    const whole = ratio(windows.referenceFrom, windows.referenceTo, windows.recentFrom, windows.recentTo);
    return whole === null ? null : (whole - 1) * 100;
  }
  const parts = windows.bins.map((b) => ({ weight: b.weight, ratio: ratio(b.referenceFrom, b.referenceTo, b.recentFrom, b.recentTo) }));
  if (parts.some((p) => p.ratio === null)) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return (parts.reduce((sum, p) => sum + (p.weight / totalWeight) * (p.ratio as number), 0) - 1) * 100;
}

function trueEffectOf(ctx: InjectionContext, detectorId: EvalDetectorId, assetPath: string, magnitude: number, last: DetectionRecord | undefined): number | null {
  if (detectorId === 'el.voltage_rise' || detectorId === 'fc.voltage_decay') return magnitude;
  if (detectorId === 'pv.inverter_peer') return -magnitude;
  if (detectorId !== 'ess.capacity_fade' || !last?.windows) return null;
  return trueCapacityEffect(ctx.prepared.soh[assetPath], last.windows);
}

function capacityStatusesOf(runs: readonly { readonly now: number; readonly outcomes: readonly DetectorOutcome[] }[]): CheckpointStatus[] {
  return runs.flatMap(({ now, outcomes }) => outcomes.flatMap((o) => (o.detectorId === 'ess.capacity_fade' && o.assetId !== null ? [{ ts: now, assetId: o.assetId, status: o.status }] : [])));
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

/** 정답의 부수 탐지기 → 주입 설비와 하위 설비 id 구간 */
export function relatedWindowsOf(site: EvalSite, injections: readonly InjectionTruth[]): RelatedWindow[] {
  return injections.flatMap((injection) => {
    const path = injection.assetPath;
    const detectors = injection.relatedDetectors ?? [];
    if (path === null || detectors.length === 0) return [];
    const assetIds = [...site.byPath.entries()].filter(([p]) => p === path || p.startsWith(`${path}/`)).map(([, a]) => a.id);
    return detectors.map((detectorId) => ({ detectorId, assetIds, startTs: injection.startTs, endTs: injection.endTs }));
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
  const runs = checkpointTs.map((now) => ({ now, outcomes: outcomesAt(index, prepared, now, detectorIds) }));
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
    applicableAssets: Object.fromEntries(EVAL_DETECTOR_IDS.map((id) => [id, id === 'dq.gap_flatline' ? dqAssetCount(prepared.dq) : index.assetsOfClass(EVAL_DETECTOR_CLASS[id]).length])),
    detections,
    injections,
    related: relatedWindowsOf(site, prepared.truth.injections),
    controls: prepared.truth.controls,
    tallies: tallyOutcomes(runs.flatMap((r) => r.outcomes)),
    capacityStatuses: capacityStatusesOf(runs),
    stats: { ...prepared.stats, detectionMs: clock() - started, episodes: prepared.episodes.length },
  };
}

export const replaySiteJob = (job: SiteJob, options: EvaluateOptions = {}): SiteJobResult => evaluatePreparedJob(prepareSiteJob(job, options.now), options);
