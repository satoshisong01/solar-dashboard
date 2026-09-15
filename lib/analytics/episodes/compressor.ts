// 수소 압축기 운전 에피소드: comp.run@1 (comp.sec_rise 입력).
// 운전 = compressor.power > 정격 × runningFraction 샘플이 maxGapS 안 간격으로 minRunS 이상 이어진 구간.
// 입력 메트릭 (압축기 + 연결 설비를 한 맵으로):
//   압축기  compressor.power(kW, 필수) · compressor.suction.pressure · compressor.discharge.pressure(bar, 절대압으로 본다)
//          · compressor.discharge.temp(°C) · compressor.leak.pressure(bar) · vibration.rms(mm/s) · run.hours(h)
//   이송 질량  h2.flow.mass(kg/h, 압축기로 들어가는 전해조 제품 유량) 우선, 없으면 h2.inventory(kg, 저장뱅크 재고 증가 — 운전 중 연료전지 인출이 섞이면 과소)
//   흡입 온도 대용  ambient.temp(°C, 사이트 기상) — 카탈로그에 압축기 흡입 가스 온도 메트릭이 없다
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND, type TimeWindow } from '../types';
import { binFloor, goodPoints, meanValue, metricDq, nominalPeriodMs, pointsIn, rangeIntegral, round, roundOrNull, valueNear, type TimedValue } from './series';
import { extractorId, validity, type Episode, type ExtractInput } from './types';

export interface CompressorNameplate {
  readonly rated_kw: number;
}

export interface CompressorRunParams {
  readonly runningFraction: number;
  readonly minRunS: number;
  readonly maxGapS: number;
  readonly fallbackPeriodS: number;
  /** 토출 온도는 기동 뒤 늦게 오르므로 운전 후반(이 비율 이후) 평균만 쓴다 */
  readonly dischargeTempFromFraction: number;
  readonly ratioBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
}

export const DEFAULT_COMPRESSOR_RUN_PARAMS: CompressorRunParams = Object.freeze({
  runningFraction: 0.1,
  minRunS: 1800,
  maxGapS: 900,
  fallbackPeriodS: 300,
  dischargeTempFromFraction: 0.5,
  ratioBinWidth: 2,
  tempBinWidthC: 5,
  minCompleteness: 0.8,
});

export type CompRunFeatures = {
  readonly duration_s: number;
  readonly energy_kwh: number | null;
  readonly mass_kg: number | null;
  readonly mass_source: 'flow' | 'inventory' | null;
  readonly sec_kwh_per_kg: number | null;
  readonly suction_bar: number | null;
  readonly discharge_bar: number | null;
  readonly pressure_ratio: number | null;
  readonly discharge_temp_c: number | null;
  readonly leak_pressure_max_bar: number | null;
  readonly vibration_mm_s: number | null;
  readonly ambient_c: number | null;
  readonly op_hours_cum: number | null;
};
export type CompRunConditions = { readonly ratio_bin: number | null; readonly t_bin: number | null };
export type CompRunEpisode = Episode<'comp.run', CompRunFeatures, CompRunConditions>;

interface Run extends TimeWindow {
  readonly open: boolean;
}

function runsOf(power: readonly TimedValue[], window: TimeWindow, thresholdKw: number, periodMs: number, p: CompressorRunParams): Run[] {
  const maxGapMs = p.maxGapS * MS_PER_SECOND;
  const edgeMs = periodMs + maxGapMs;
  const runs: Run[] = [];
  let first: number | null = null;
  let last = 0;
  const close = (dataEnded: boolean) => {
    if (first !== null && last + periodMs - first >= p.minRunS * MS_PER_SECOND) {
      runs.push({ start: first, end: last + periodMs, open: first - window.start <= edgeMs || (dataEnded && window.end - (last + periodMs) <= edgeMs) });
    }
    first = null;
  };
  for (const point of power) {
    if (point.value <= thresholdKw || (first !== null && point.ts - last > maxGapMs)) close(false);
    if (point.value > thresholdKw) {
      first ??= point.ts;
      last = point.ts;
    }
  }
  close(true);
  return runs;
}

const meanIn = (points: readonly TimedValue[], range: TimeWindow): number | null => meanValue(pointsIn(points, range));

/** 메트릭별 good 샘플 (운전마다 전체 시계열을 다시 거르지 않도록 한 번만 만든다) */
type Signals = Readonly<Record<'power' | 'flow' | 'inventory' | 'suction' | 'discharge' | 'dischargeTemp' | 'leak' | 'vibration' | 'ambient' | 'runHours', readonly TimedValue[]>> & {
  /** 이송 질량 신호 공칭 주기 (운전마다 다시 계산하지 않는다) */
  readonly flowPeriodMs: number;
  readonly inventoryPeriodMs: number;
};

function signalsOf(series: ExtractInput<CompressorNameplate>['series']): Signals {
  const good = (metric: string) => goodPoints(series, metric);
  const flow = good('h2.flow.mass');
  const inventory = good('h2.inventory');
  return {
    power: good('compressor.power'),
    flow,
    inventory,
    flowPeriodMs: nominalPeriodMs(flow, 5 * MS_PER_MINUTE),
    inventoryPeriodMs: nominalPeriodMs(inventory, 5 * MS_PER_MINUTE),
    suction: good('compressor.suction.pressure'),
    discharge: good('compressor.discharge.pressure'),
    dischargeTemp: good('compressor.discharge.temp'),
    leak: good('compressor.leak.pressure'),
    vibration: good('vibration.rms'),
    ambient: good('ambient.temp'),
    runHours: good('run.hours'),
  };
}

function massOf(signals: Signals, run: Run): Pick<CompRunFeatures, 'mass_kg' | 'mass_source'> {
  const { flow, inventory } = signals;
  if (flow.length > 0) {
    const kg = rangeIntegral(flow, run, signals.flowPeriodMs);
    if (kg !== null) return { mass_kg: round(kg, 4), mass_source: 'flow' };
  }
  const tolerance = 2 * signals.inventoryPeriodMs;
  const before = valueNear(inventory, run.start, tolerance);
  const after = valueNear(inventory, run.end, tolerance);
  return before === null || after === null ? { mass_kg: null, mass_source: null } : { mass_kg: round(after - before, 4), mass_source: 'inventory' };
}

function featuresOf(signals: Signals, run: Run, periodMs: number, p: CompressorRunParams): CompRunFeatures {
  const energy = rangeIntegral(signals.power, run, periodMs);
  const mass = massOf(signals, run);
  const suction = meanIn(signals.suction, run);
  const discharge = meanIn(signals.discharge, run);
  const lateRange = { start: run.start + (run.end - run.start) * p.dischargeTempFromFraction, end: run.end };
  const leak = pointsIn(signals.leak, run);
  const midpoint = (run.start + run.end) / 2;
  const { ambient } = signals;
  return {
    duration_s: (run.end - run.start) / MS_PER_SECOND,
    energy_kwh: roundOrNull(energy, 4),
    ...mass,
    sec_kwh_per_kg: energy !== null && mass.mass_kg !== null && mass.mass_kg > 0 ? round(energy / mass.mass_kg, 4) : null,
    suction_bar: roundOrNull(suction, 3),
    discharge_bar: roundOrNull(discharge, 3),
    pressure_ratio: suction !== null && discharge !== null && suction > 0 ? round(discharge / suction, 4) : null,
    discharge_temp_c: roundOrNull(meanIn(signals.dischargeTemp, lateRange), 3),
    leak_pressure_max_bar: leak.length === 0 ? null : round(Math.max(...leak.map((pt) => pt.value)), 4),
    vibration_mm_s: roundOrNull(meanIn(signals.vibration, run), 4),
    ambient_c: roundOrNull(meanIn(ambient, run) ?? valueNear(ambient, midpoint, MS_PER_HOUR), 3),
    op_hours_cum: roundOrNull(valueNear(signals.runHours, midpoint, MS_PER_HOUR), 3),
  };
}

/** 원시 샘플 → comp.run 에피소드. 전력 샘플이 없으면 빈 결과 */
export function extractCompressorRuns(input: ExtractInput<CompressorNameplate>, overrides: Partial<CompressorRunParams> = {}): CompRunEpisode[] {
  const p = { ...DEFAULT_COMPRESSOR_RUN_PARAMS, ...overrides };
  if (!(input.nameplate.rated_kw > 0)) throw new RangeError('comp.run 추출: 압축기 정격(rated_kw)이 올바르지 않습니다');
  const signals = signalsOf(input.series);
  const power = pointsIn(signals.power, input.window);
  const periodMs = nominalPeriodMs(power, p.fallbackPeriodS * MS_PER_SECOND);
  return runsOf(power, input.window, p.runningFraction * input.nameplate.rated_kw, periodMs, p).map((run): CompRunEpisode => {
    const features = featuresOf(signals, run, periodMs, p);
    const dq = metricDq(input.series['compressor.power'], run, periodMs);
    return {
      assetId: input.assetId,
      kind: 'comp.run',
      extractorVersion: extractorId('comp.run'),
      start: run.start,
      end: run.end,
      features,
      conditions: {
        ratio_bin: features.pressure_ratio === null ? null : binFloor(features.pressure_ratio, p.ratioBinWidth),
        t_bin: features.ambient_c === null ? null : binFloor(features.ambient_c, p.tempBinWidthC),
      },
      dq,
      open: run.open,
      ...validity(run.open, dq.completeness, p.minCompleteness),
    };
  });
}
