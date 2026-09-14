// 메모리 모드: HTTP·DB 없이 시뮬레이션해 포인트별 시계열을 타입 배열로 모은다 (탐지기 평가용, 설계 §5.5).
// 값은 수집 파이프라인이 om.measurement에 저장할 값과 같다 (원본값 × scale + value_offset, 노이즈·반올림·고착 포함).
// 전송 계층 시나리오(단절·중복 재전송·시계 오차)는 저장값을 바꾸지 않으므로 반영하지 않는다(시각 이동·CLOCK_SUSPECT 없음).
import { METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { applyScale } from '@/lib/ingest/normalize';
import { QUALITY } from '@/lib/ingest/quality';
import type { SimEvent } from './events';
import { MS_PER_SECOND, toEpochMs, type TimeInput } from './math';
import { createPlant } from './plant';
import { readingKey } from './plant-types';
import { EMPTY_PLAN, planScenarios, scenarioOriginMs, type Scenario } from './scenarios';
import { buildTruth, type SimulationTruth } from './truth';

export const MEMORY_STEP_S = 60;
/** 샘플당 저장 바이트: 값 Float64(8) + 품질 Int16(2). 시각 배열은 주기별로 공유한다. */
const BYTES_PER_SAMPLE = 10;
const BYTES_PER_TIMESTAMP = 8;
export const DEFAULT_MEMORY_MAX_BYTES = 2 * 1024 ** 3;

export interface MemoryPoint {
  readonly siteCode: string;
  readonly assetCode: string;
  /** `${사이트}/${설비 코드}` (om.asset.path) */
  readonly assetPath: string;
  readonly classKey: string;
  readonly metricKey: string;
  readonly qualifier: string;
  readonly sourceKey: string;
  readonly periodS: number;
}

export interface MemorySeries extends MemoryPoint {
  readonly key: string;
  /** 샘플 시각 [epoch ms]. 같은 주기의 시계열끼리 같은 배열을 공유하므로 수정하지 말 것 */
  readonly ts: Float64Array;
  /** 정규 단위 값 */
  readonly value: Float64Array;
  /** om.measurement.quality 비트 (HARD_RANGE만 계산) */
  readonly quality: Int16Array;
}

export interface MemorySimulationOptions {
  readonly siteCodes: readonly string[];
  readonly from: TimeInput;
  /** 이 시각 미만까지 */
  readonly to: TimeInput;
  readonly seed: number;
  readonly scenarios?: readonly Scenario[];
  /** 담을 포인트를 고른다 (생략하면 매핑된 포인트 전부). 걸러도 생성 순서·난수열은 같다. */
  readonly pointFilter?: (point: MemoryPoint) => boolean;
  /** 예상 메모리가 이보다 크면 시작하지 않는다 [byte] */
  readonly maxBytes?: number;
  /** 실행시간 측정용 시계 [ms] */
  readonly now?: () => number;
}

export interface SiteSimEvent extends SimEvent {
  readonly siteCode: string;
}

export interface MemorySimulationStats {
  readonly steps: number;
  readonly samples: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

export interface MemorySimulationResult {
  readonly fromMs: number;
  readonly toMs: number;
  readonly series: ReadonlyMap<string, MemorySeries>;
  readonly events: readonly SiteSimEvent[];
  readonly truth: SimulationTruth;
  readonly stats: MemorySimulationStats;
}

/** 시계열 키: `${설비 경로}|${메트릭}` 또는 `${설비 경로}|${메트릭}#${한정자}` (예: SIM-A/ESS1/RACK01|batt.soc) */
export const pointKey = (assetPath: string, metricKey: string, qualifier = ''): string => `${assetPath}|${readingKey(metricKey, qualifier)}`;

/**
 * 설계 §5.3 P2 탐지기 6종이 읽는 설비 종류별 메트릭.
 * batt.soh는 시뮬레이터가 참 SOH를 그대로 내보내므로(정답 누출) 넣지 않는다. 용량은 전류·SOC로 추정해야 한다.
 */
export const DETECTOR_METRICS: Readonly<Record<string, readonly string[]>> = {
  'ess.plant': ['room.temp'],
  'ess.rack': ['batt.current', 'batt.voltage', 'batt.soc', 'cell.voltage.max', 'cell.voltage.min', 'cell.voltage.avg', 'cell.temp.avg'],
  'pv.inverter': ['ac.power', 'dc.power', 'ac.power.limit', 'op.state'],
  'wx.station': ['poa.irradiance', 'module.temp', 'ambient.temp'],
  'h2.elz': ['ac.power', 'h2.flow.mass', 'op.state'],
  'h2.elz.stack': ['stack.voltage', 'stack.current', 'stack.temp', 'cell.voltage.avg', 'run.hours'],
  'fc.plant': ['fc.ac.power', 'fc.h2.consumption', 'op.state', 'start.count'],
  'fc.stack': ['stack.voltage', 'stack.current', 'stack.temp', 'cell.voltage.avg', 'run.hours'],
  'fc.blower': ['blower.power'],
};

export const detectorPointFilter = (point: MemoryPoint): boolean => DETECTOR_METRICS[point.classKey]?.includes(point.metricKey) ?? false;

interface SeriesWriter {
  readonly series: MemorySeries;
  readonly scale: number;
  readonly valueOffset: number;
  readonly hardMin: number;
  readonly hardMax: number;
  index: number;
}

const sampleCount = (firstStepMs: number, toMs: number, periodMs: number): number => {
  const first = Math.ceil(firstStepMs / periodMs) * periodMs;
  return first < toMs ? Math.floor((toMs - 1 - first) / periodMs) + 1 : 0;
};

function findSite(code: string): SiteDef {
  const site = SIM_SITES.find((s) => s.code === code);
  if (!site) throw new Error(`알 수 없는 가상 사이트: ${code}`);
  return site;
}

function selectedPoints(site: SiteDef, filter: MemorySimulationOptions['pointFilter']) {
  return site.assets.flatMap((asset) =>
    asset.points
      .map((p) => ({
        info: { siteCode: site.code, assetCode: asset.code, assetPath: `${site.code}/${asset.code}`, classKey: asset.classKey, metricKey: p.metricKey, qualifier: p.qualifier, sourceKey: p.sourceKey, periodS: p.periodS },
        point: p,
      }))
      .filter(({ info }) => filter?.(info) ?? true),
  );
}

type SelectedPoint = ReturnType<typeof selectedPoints>[number];

function createWriters(points: readonly SelectedPoint[], timestamps: (periodS: number) => Float64Array): Map<string, SeriesWriter> {
  return new Map(
    points.map(({ info, point }) => {
      const metric = METRIC_DEF_BY_KEY.get(point.metricKey);
      if (!metric) throw new Error(`카탈로그에 없는 메트릭: ${point.metricKey} (${point.sourceKey})`);
      const ts = timestamps(point.periodS);
      const series: MemorySeries = { ...info, key: pointKey(info.assetPath, info.metricKey, info.qualifier), ts, value: new Float64Array(ts.length), quality: new Int16Array(ts.length) };
      const writer: SeriesWriter = { series, scale: point.scale, valueOffset: point.valueOffset, hardMin: metric.hardMin ?? -Infinity, hardMax: metric.hardMax ?? Infinity, index: 0 };
      return [point.sourceKey, writer];
    }),
  );
}

function timestampCache(firstStepMs: number, toMs: number): (periodS: number) => Float64Array {
  const cache = new Map<number, Float64Array>();
  return (periodS) => {
    const cached = cache.get(periodS);
    if (cached) return cached;
    const periodMs = periodS * MS_PER_SECOND;
    const first = Math.ceil(firstStepMs / periodMs) * periodMs;
    const ts = Float64Array.from({ length: sampleCount(firstStepMs, toMs, periodMs) }, (_, i) => first + i * periodMs);
    cache.set(periodS, ts);
    return ts;
  };
}

function estimateBytes(points: readonly SelectedPoint[], firstStepMs: number, toMs: number): number {
  const counts = points.map(({ point }) => sampleCount(firstStepMs, toMs, point.periodS * MS_PER_SECOND));
  const periods = new Set(points.map(({ point }) => point.periodS));
  const tsBytes = [...periods].reduce((sum, periodS) => sum + sampleCount(firstStepMs, toMs, periodS * MS_PER_SECOND) * BYTES_PER_TIMESTAMP, 0);
  return counts.reduce((sum, n) => sum + n * BYTES_PER_SAMPLE, 0) + tsBytes;
}

/**
 * [from, to)를 60초 스텝으로 시뮬레이션해 포인트별 시계열을 만든다. 같은 옵션이면 simulate()가 보내는 값과 같다.
 * 1년 × 3사이트 전체 포인트는 약 1 GB이므로 탐지기 평가에는 pointFilter(detectorPointFilter)나 사이트별 실행을 권장한다.
 */
export function simulateMemory(options: MemorySimulationOptions): MemorySimulationResult {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const fromMs = toEpochMs(options.from, 'from');
  const toMs = toEpochMs(options.to, 'to');
  const scenarios = options.scenarios ?? [];
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error(`seed는 0 이상의 정수여야 합니다: ${options.seed}`);
  if (options.siteCodes.length === 0 || new Set(options.siteCodes).size !== options.siteCodes.length) {
    throw new Error('siteCodes는 비어 있지 않고 중복이 없어야 합니다');
  }
  const truth = buildTruth({ siteCodes: options.siteCodes, from: fromMs, to: toMs, scenarios }); // 기간·시나리오 검증 포함
  const sites = options.siteCodes.map(findSite);
  const plans = planScenarios(sites, scenarios, { originMs: scenarioOriginMs(fromMs) });
  const stepMs = MEMORY_STEP_S * MS_PER_SECOND;
  const firstStepMs = Math.ceil(fromMs / stepMs) * stepMs;
  const pointsBySite = sites.map((site) => selectedPoints(site, options.pointFilter));
  const bytes = estimateBytes(pointsBySite.flat(), firstStepMs, toMs);
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  if (bytes > maxBytes) throw new Error(`예상 메모리 ${Math.ceil(bytes / 1024 ** 2)} MB가 한도 ${Math.floor(maxBytes / 1024 ** 2)} MB를 넘습니다. pointFilter로 포인트를 줄이거나 사이트별로 나눠 실행하세요`);

  const timestamps = timestampCache(firstStepMs, toMs);
  const series = new Map<string, MemorySeries>();
  const events: SiteSimEvent[] = [];
  let steps = 0;
  sites.forEach((site, i) => {
    const writers = createWriters(pointsBySite[i] ?? [], timestamps);
    const plant = createPlant({ site, seed: options.seed, startMs: firstStepMs - stepMs, stepS: MEMORY_STEP_S, plan: plans.get(site.code) ?? EMPTY_PLAN });
    for (let tMs = firstStepMs; tMs < toMs; tMs += stepMs) {
      const output = plant.step(tMs);
      steps += 1;
      for (const sample of output.samples) {
        const writer = writers.get(sample.sourceKey);
        if (!writer) continue;
        const value = applyScale(sample.value, writer);
        writer.series.value[writer.index] = value;
        writer.series.quality[writer.index] = value < writer.hardMin || value > writer.hardMax ? QUALITY.HARD_RANGE : 0;
        writer.index += 1;
      }
      for (const event of output.events) events.push({ ...event, siteCode: site.code });
    }
    for (const writer of writers.values()) {
      if (writer.index !== writer.series.ts.length) throw new Error(`${writer.series.key} 샘플 수가 예상과 다릅니다: ${writer.index} / ${writer.series.ts.length}`);
      series.set(writer.series.key, writer.series);
    }
  });

  const samples = [...series.values()].reduce((sum, s) => sum + s.value.length, 0);
  return { fromMs, toMs, series, events, truth, stats: { steps, samples, bytes, elapsedMs: now() - startedAt } };
}
