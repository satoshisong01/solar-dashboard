// 연계형 발전소 시뮬레이터 진입점.
// simulate()는 사이트별 게이트웨이가 보낼 om.ingest.v1 봉투를 전송 순서대로 내보낸다(서명·전송은 호출자 몫).
import { SEED_SITES } from '@/db/seed/sites';
import type { GatewayDef, SiteDef } from '@/db/seed/types';
import { buildEnvelope, type GatewayClock, type IngestEnvelope } from './envelope';
import type { SimEvent } from './events';
import { MS_PER_MINUTE, MS_PER_SECOND, toEpochMs, type TimeInput } from './math';
import { createPlant, type Plant, type PlantSample } from './plant';
import { deriveRng, type Rng } from './rng';
import { clockSkewAt, EMPTY_PLAN, isSampleLost, planScenarios, scenarioOriginMs, type Scenario, type SiteScenarioPlan } from './scenarios';
import { createGatewayTransport, type GatewayTransport, type PendingBatch, type Transmission } from './transport';

export const DEFAULT_STEP_S = 60;
export const DEFAULT_BATCH_PERIOD_S = 300;
/** 설계 §5.1 규칙 2: 배치당 샘플 5,000개 이하 권장 */
export const DEFAULT_MAX_SAMPLES_PER_BATCH = 5_000;
/** 설계 §5.1 규칙 6: 서버 시각 +5분을 넘는 샘플은 거부된다 */
export const FUTURE_TOLERANCE_MS = 5 * MS_PER_MINUTE;
/** seq = 배치 창 번호 × 100 + 분할 번호 */
const SEQ_PARTS = 100;

export interface SimulateOptions {
  readonly siteCodes: readonly string[];
  readonly from: TimeInput;
  /** 이 시각 미만까지 */
  readonly to: TimeInput;
  readonly seed: number;
  readonly stepS?: number;
  readonly scenarios?: readonly Scenario[];
  /** 게이트웨이 flush 주기 (기본 300초) */
  readonly batchPeriodS?: number;
  readonly maxSamplesPerBatch?: number;
  /** 적재 시점의 서버 시각. 생략하면 봉투의 실제 전송 시각에 서버가 받는다고 본다(실시간 재생). */
  readonly serverNowMs?: number;
}

export interface SimulatedBatch {
  readonly siteCode: string;
  readonly gateway: GatewayDef;
  readonly envelope: IngestEnvelope;
  /** 이 봉투로 om.measurement에 새로 들어가야 할 고유 샘플 수 (재전송·미래 샘플·미매핑 제외) */
  readonly expectedSamples: number;
  /** 미매핑 태그 샘플 수 (재전송·미래 제외) */
  readonly expectedUnmappedSamples: number;
  readonly resend: boolean;
  readonly backfill: boolean;
  /** 실제 전송 시각 (게이트웨이 시계 오차 제외) */
  readonly sentAtMs: number;
}

interface RunConfig {
  readonly siteCodes: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly seed: number;
  readonly stepS: number;
  readonly batchMs: number;
  readonly maxSamples: number;
  readonly serverNowMs: number | undefined;
}

interface SiteRunner {
  readonly site: SiteDef;
  readonly plan: SiteScenarioPlan;
  readonly plant: Plant;
  readonly transport: GatewayTransport;
  readonly clockRng: Rng;
}

interface WindowBuffer {
  readonly samples: PlantSample[];
  readonly events: SimEvent[];
}

function requireInteger(value: number, label: string, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label}은(는) ${min} 이상의 정수여야 합니다: ${value}`);
  return value;
}

function normalizeOptions(options: SimulateOptions): RunConfig {
  const stepS = requireInteger(options.stepS ?? DEFAULT_STEP_S, 'stepS', 1);
  const batchPeriodS = requireInteger(options.batchPeriodS ?? DEFAULT_BATCH_PERIOD_S, 'batchPeriodS', 1);
  if (batchPeriodS % stepS !== 0) throw new Error(`batchPeriodS(${batchPeriodS})는 stepS(${stepS})의 배수여야 합니다`);
  const fromMs = toEpochMs(options.from, 'from');
  const toMs = toEpochMs(options.to, 'to');
  if (toMs <= fromMs) throw new Error('to는 from보다 늦어야 합니다');
  if (options.siteCodes.length === 0 || new Set(options.siteCodes).size !== options.siteCodes.length) {
    throw new Error('siteCodes는 비어 있지 않고 중복이 없어야 합니다');
  }
  return {
    siteCodes: options.siteCodes,
    fromMs,
    toMs,
    seed: requireInteger(options.seed, 'seed', 0),
    stepS,
    batchMs: batchPeriodS * MS_PER_SECOND,
    maxSamples: requireInteger(options.maxSamplesPerBatch ?? DEFAULT_MAX_SAMPLES_PER_BATCH, 'maxSamplesPerBatch', 1),
    serverNowMs: options.serverNowMs,
  };
}

/** 시드에 있는 사이트만 시뮬레이션한다. 실사이트를 넣을지는 호출자(scripts/sim-shared.ts)가 설정으로 정한다. */
function findSite(code: string): SiteDef {
  const site = SEED_SITES.find((s) => s.code === code);
  if (!site) throw new Error(`알 수 없는 사이트: ${code}`);
  return site;
}

function createRunner(site: SiteDef, plan: SiteScenarioPlan, config: RunConfig, firstStepMs: number): SiteRunner {
  return {
    site,
    plan,
    plant: createPlant({ site, seed: config.seed, startMs: firstStepMs - config.stepS * MS_PER_SECOND, stepS: config.stepS, plan }),
    transport: createGatewayTransport(plan, deriveRng(config.seed, site.gateway.code, 'transport')),
    clockRng: deriveRng(config.seed, site.gateway.code, 'clock'),
  };
}

/** 한 창의 샘플을 배치 크기 한도로 나눈다. 이벤트는 첫 배치에 싣는다. */
function splitWindow(buffer: WindowBuffer, windowIndex: number, windowEndMs: number, maxSamples: number): PendingBatch[] {
  const partCount = Math.max(1, Math.ceil(buffer.samples.length / maxSamples));
  if (partCount > SEQ_PARTS) throw new Error(`한 창의 샘플이 너무 많습니다(${buffer.samples.length}). batchPeriodS를 줄이세요`);
  if (buffer.samples.length === 0 && buffer.events.length === 0) return [];
  return Array.from({ length: partCount }, (_, part) => ({
    seq: windowIndex * SEQ_PARTS + part,
    windowEndMs,
    samples: buffer.samples.slice(part * maxSamples, (part + 1) * maxSamples),
    events: part === 0 ? buffer.events : [],
  }));
}

/**
 * 시계 오차가 있는 배치는 NTP 미동기, 아니면 동기 상태와 작은 오프셋.
 * lib/ingest 스키마는 ntp_offset_ms를 필수로 받으므로 미동기일 때는 알 수 없는 오프셋을 0으로 보낸다.
 */
function gatewayClock(runner: SiteRunner, skewMs: number): GatewayClock {
  if (skewMs !== 0) return { ntp_synced: false, ntp_offset_ms: 0 };
  return { ntp_synced: true, ntp_offset_ms: Math.round(4 * runner.clockRng.gaussian()) };
}

function toSimulatedBatches(runner: SiteRunner, transmissions: readonly Transmission[], config: RunConfig): SimulatedBatch[] {
  const sentBySeq = new Map<number, IngestEnvelope>();
  return transmissions.map((transmission): SimulatedBatch => {
    const { batch } = transmission;
    // 시계 오차는 배치 단위: 전송 시각이 오차 구간 안이면 그 배치의 샘플·이벤트·sent_at을 모두 민다.
    const skewMs = clockSkewAt(runner.plan, transmission.sentAtMs);
    const cached = transmission.resend ? sentBySeq.get(batch.seq) : undefined;
    if (transmission.resend && !cached) throw new Error(`재전송할 원본 봉투가 없습니다: seq ${batch.seq}`);
    const envelope =
      cached ??
      buildEnvelope({
        seed: config.seed,
        gateway: runner.site.gateway.code,
        seq: batch.seq,
        sentAtMs: transmission.sentAtMs + skewMs,
        clock: gatewayClock(runner, skewMs),
        samples: batch.samples.map((s) => ({ sourceKey: s.sourceKey, unit: s.unit, periodS: s.periodS, ts: s.ts + skewMs, value: s.value })),
        events: batch.events.map((e) => ({ ...e, ts: e.ts + skewMs })),
      });
    sentBySeq.set(batch.seq, envelope);
    const cutoffMs = (config.serverNowMs ?? transmission.sentAtMs) + FUTURE_TOLERANCE_MS;
    const accepted = transmission.resend ? [] : batch.samples.filter((s) => s.ts + skewMs <= cutoffMs);
    return {
      siteCode: runner.site.code,
      gateway: runner.site.gateway,
      envelope,
      expectedSamples: accepted.filter((s) => s.mapped).length,
      expectedUnmappedSamples: accepted.filter((s) => !s.mapped).length,
      resend: transmission.resend,
      backfill: transmission.backfill,
      sentAtMs: transmission.sentAtMs,
    };
  });
}

const emptyBuffer = (): WindowBuffer => ({ samples: [], events: [] });

/**
 * [from, to) 구간을 stepS 간격으로 시뮬레이션해 게이트웨이 봉투를 전송 순서대로 내보낸다.
 * 같은 옵션이면 같은 봉투(같은 batch_id)가 나온다. 일수 기반 시나리오의 0일째는 scenarioOriginMs(from)이다.
 */
export async function* simulate(options: SimulateOptions): AsyncGenerator<SimulatedBatch> {
  const config = normalizeOptions(options);
  const sites = config.siteCodes.map(findSite);
  const plans = planScenarios(sites, options.scenarios ?? [], { originMs: scenarioOriginMs(config.fromMs) });
  const stepMs = config.stepS * MS_PER_SECOND;
  const firstStepMs = Math.ceil(config.fromMs / stepMs) * stepMs;
  const runners = sites.map((site) => createRunner(site, plans.get(site.code) ?? EMPTY_PLAN, config, firstStepMs));

  let windowIndex = Math.floor(firstStepMs / config.batchMs);
  let buffers = runners.map(emptyBuffer);
  const flush = function* (): Generator<SimulatedBatch> {
    const windowEndMs = (windowIndex + 1) * config.batchMs;
    for (const [i, runner] of runners.entries()) {
      const buffer = buffers[i] ?? emptyBuffer();
      const transmissions = splitWindow(buffer, windowIndex, windowEndMs, config.maxSamples).flatMap((b) => runner.transport.push(b));
      yield* toSimulatedBatches(runner, transmissions, config);
    }
    buffers = runners.map(emptyBuffer);
  };

  for (let tMs = firstStepMs; tMs < config.toMs; tMs += stepMs) {
    const index = Math.floor(tMs / config.batchMs);
    if (index !== windowIndex) {
      yield* flush();
      windowIndex = index;
    }
    for (const [i, runner] of runners.entries()) {
      const output = runner.plant.step(tMs);
      buffers[i]?.samples.push(...output.samples.filter((s) => !isSampleLost(runner.plan, s.sourceKey, s.ts)));
      buffers[i]?.events.push(...output.events);
    }
  }
  yield* flush();
  for (const runner of runners) yield* toSimulatedBatches(runner, runner.transport.finish(), config);
}

export { createPlant } from './plant';
export type { Plant, PlantSample, PlantStep } from './plant';
export { DEGRADATION_PARAMS, planScenarios, scenarioOriginMs } from './scenarios';
export type { DegradationHook, DegradationParam, FaultScenario, PlanOptions, Scenario, SiteScenarioPlan } from './scenarios';
export type { TypedFaultScenario } from './fault-scenarios';
export type { ControlScenario } from './control-scenarios';
export type { P3FaultScenario } from './fault-scenarios-p3';
export type { P3ControlScenario } from './control-scenarios-p3';
export { buildTruth } from './truth';
export type { AssetEventTruth, ControlEventTruth, InjectionTruth, SimulationTruth } from './truth';
export { detectorPointFilter, DETECTOR_METRICS, P3_DETECTOR_METRICS, p3DetectorPointFilter, pointKey, simulateMemory } from './memory';
export type { MemoryPoint, MemorySeries, MemorySimulationOptions, MemorySimulationResult } from './memory';
export { INGEST_SCHEMA } from './envelope';
export type { IngestEnvelope, IngestEvent, IngestSeries } from './envelope';
export type { SimEvent } from './events';
