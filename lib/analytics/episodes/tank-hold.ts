// 수소 저장용기 정지 보유 구간: tank.hold@1 (tank.static_leak 입력).
// 정지 = 유입·유출이 모두 없음: 뱅크 입·출구 차단밸브 닫힘, 압축기 정지(전력 ≤ compressorOffKw), 전해조 제품 유량·연료전지 수소 소비 ≈ 0.
//   유입 쪽(입구 밸브·압축기 전력·전해조 유량)과 유출 쪽(출구 밸브·연료전지 소비) 신호가 하나씩은 있어야 정지로 확정한다. 없으면 빈 결과.
//   신호가 있는데 그 시각 값이 없으면(오래됨·결측) 정지로 보지 않는다 (보수적).
// 충전·방출 직후 가스 냉각·열 지연을 피하려고 정지 시작 뒤 settleS는 잘라 낸다.
// 입력 메트릭 (용기 + 뱅크·압축기·전해조·연료전지를 한 맵으로):
//   tank.pressure(bar, 절대압, 필수) · tank.temp(°C, 필수) · valve.open#inlet · valve.open#outlet · compressor.power(kW)
//   · h2.flow.mass(kg/h) · fc.h2.consumption(kg/h) · h2.pressure(bar, 연료전지 공급 압력 = 하류 압력, 밸브 통과 누설 체크)
import { MS_PER_SECOND, type AssetSeries, type TimeWindow } from '../types';
import { binFloor, goodPoints, meanValue, metricDq, nominalPeriodMs, pointsIn, round, roundOrNull, valueAtOrBefore, valueNear, type TimedValue } from './series';
import { extractorId, validity, type Episode, type ExtractInput } from './types';

export interface TankNameplate {
  readonly water_volume_l: number;
}

export interface TankHoldParams {
  readonly compressorOffKw: number;
  readonly flowEpsKgH: number;
  readonly minHoldS: number;
  readonly settleS: number;
  readonly maxGapS: number;
  readonly fallbackPeriodS: number;
  /** 밸브·유량 신호 값을 찾을 때 허용하는 시차 */
  readonly signalToleranceS: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
}

export const DEFAULT_TANK_HOLD_PARAMS: TankHoldParams = Object.freeze({
  compressorOffKw: 1,
  flowEpsKgH: 0.05,
  minHoldS: 3600,
  settleS: 3600,
  maxGapS: 900,
  fallbackPeriodS: 300,
  signalToleranceS: 900,
  tempBinWidthC: 5,
  minCompleteness: 0.8,
});

export type TankHoldFeatures = {
  readonly duration_s: number;
  readonly settle_s: number;
  readonly n_points: number;
  readonly p_start_bar: number | null;
  readonly p_end_bar: number | null;
  readonly p_mean_bar: number | null;
  readonly t_mean_c: number | null;
  readonly t_min_c: number | null;
  readonly t_max_c: number | null;
  /** 하류(연료전지 공급) 압력 끝 − 시작 [bar]. 신호가 없으면 null */
  readonly downstream_p_rise_bar: number | null;
};
export type TankHoldConditions = { readonly t_bin: number | null };
export type TankHoldEpisode = Episode<'tank.hold', TankHoldFeatures, TankHoldConditions>;

/** 정지 구간의 압력·온도 짝 (tank.static_leak 입력) */
export interface TankHoldPoint {
  readonly ts: number;
  readonly pressureBar: number;
  readonly tempC: number;
}

interface FlowSignal {
  readonly points: readonly TimedValue[];
  /** 이 값이면 흐름 없음 */
  readonly idle: (value: number) => boolean;
}

function flowSignals(series: AssetSeries, p: TankHoldParams): { inflow: FlowSignal[]; outflow: FlowSignal[] } {
  const closed = (value: number) => value < 0.5;
  const noFlow = (value: number) => Math.abs(value) <= p.flowEpsKgH;
  const signal = (metric: string, idle: (value: number) => boolean): FlowSignal[] => {
    const points = goodPoints(series, metric);
    return points.length === 0 ? [] : [{ points, idle }];
  };
  return {
    inflow: [...signal('valve.open#inlet', closed), ...signal('compressor.power', (v) => v <= p.compressorOffKw), ...signal('h2.flow.mass', noFlow)],
    outflow: [...signal('valve.open#outlet', closed), ...signal('fc.h2.consumption', noFlow)],
  };
}

function runsOf(pressure: readonly TimedValue[], isStatic: (ts: number) => boolean, window: TimeWindow, periodMs: number, p: TankHoldParams): (TimeWindow & { open: boolean })[] {
  const maxGapMs = p.maxGapS * MS_PER_SECOND;
  const edgeMs = periodMs + maxGapMs;
  const runs: (TimeWindow & { open: boolean })[] = [];
  let first: number | null = null;
  let last = 0;
  const close = (dataEnded: boolean) => {
    if (first !== null) {
      const start = first + p.settleS * MS_PER_SECOND;
      const end = last + periodMs;
      if (end - start >= p.minHoldS * MS_PER_SECOND) runs.push({ start, end, open: first - window.start <= edgeMs || (dataEnded && window.end - end <= edgeMs) });
    }
    first = null;
  };
  for (const point of pressure) {
    const still = isStatic(point.ts);
    if (!still || (first !== null && point.ts - last > maxGapMs)) close(false);
    if (still) {
      first ??= point.ts;
      last = point.ts;
    }
  }
  close(true);
  return runs;
}

/** 온도 짝 허용 시차 = 온도 공칭 주기 × 1.5 (구간마다 다시 계산하지 않도록 한 번만 구한다) */
const tempTolerance = (temps: readonly TimedValue[]): number => 1.5 * nominalPeriodMs(temps, 300_000);

function pairPoints(pressure: readonly TimedValue[], temps: readonly TimedValue[], toleranceMs: number, hold: TimeWindow): TankHoldPoint[] {
  return pointsIn(pressure, hold).flatMap((pt) => {
    const tempC = valueNear(temps, pt.ts, toleranceMs);
    return tempC === null ? [] : [{ ts: pt.ts, pressureBar: pt.value, tempC }];
  });
}

/** 정지 구간 안 압력 샘플마다 가장 가까운 온도를 짝지은 점 (온도가 없는 점은 뺀다) */
export function tankHoldPoints(series: AssetSeries, hold: TimeWindow): TankHoldPoint[] {
  return tankHoldPointsMany(series, [hold])[0] ?? [];
}

/** 여러 구간을 한 번에: good 필터·온도 주기는 한 번만 계산한다 */
export function tankHoldPointsMany(series: AssetSeries, holds: readonly TimeWindow[]): TankHoldPoint[][] {
  const pressure = goodPoints(series, 'tank.pressure');
  const temps = goodPoints(series, 'tank.temp');
  const tolerance = tempTolerance(temps);
  return holds.map((hold) => pairPoints(pressure, temps, tolerance, hold));
}

/** 원시 샘플 → tank.hold 에피소드. 유입·유출 신호가 한쪽이라도 없으면 빈 결과 */
export function extractTankHolds(input: ExtractInput<TankNameplate>, overrides: Partial<TankHoldParams> = {}): TankHoldEpisode[] {
  const p = { ...DEFAULT_TANK_HOLD_PARAMS, ...overrides };
  if (!(input.nameplate.water_volume_l > 0)) throw new RangeError('tank.hold 추출: 용기 내용적(water_volume_l)이 올바르지 않습니다');
  const { inflow, outflow } = flowSignals(input.series, p);
  if (inflow.length === 0 || outflow.length === 0) return [];
  const toleranceMs = p.signalToleranceS * MS_PER_SECOND;
  const isStatic = (ts: number) =>
    [...inflow, ...outflow].every((signal) => {
      const value = valueAtOrBefore(signal.points, ts, toleranceMs);
      return value !== null && signal.idle(value);
    });
  const allPressure = goodPoints(input.series, 'tank.pressure');
  const temperature = goodPoints(input.series, 'tank.temp');
  const temperatureTolerance = tempTolerance(temperature);
  const pressure = pointsIn(allPressure, input.window);
  const periodMs = nominalPeriodMs(pressure, p.fallbackPeriodS * MS_PER_SECOND);
  const downstream = goodPoints(input.series, 'h2.pressure');
  return runsOf(pressure, isStatic, input.window, periodMs, p).map((run): TankHoldEpisode => {
    const points = pairPoints(allPressure, temperature, temperatureTolerance, run);
    const temps = points.map((pt) => pt.tempC);
    const downStart = valueNear(downstream, run.start, toleranceMs);
    const downEnd = valueNear(downstream, run.end, toleranceMs);
    const dq = metricDq(input.series['tank.pressure'], run, periodMs);
    const tMean = meanValue(points.map((pt) => ({ ts: pt.ts, value: pt.tempC })));
    return {
      assetId: input.assetId,
      kind: 'tank.hold',
      extractorVersion: extractorId('tank.hold'),
      start: run.start,
      end: run.end,
      features: {
        duration_s: (run.end - run.start) / MS_PER_SECOND,
        settle_s: p.settleS,
        n_points: points.length,
        p_start_bar: roundOrNull(points[0]?.pressureBar ?? null, 4),
        p_end_bar: roundOrNull(points[points.length - 1]?.pressureBar ?? null, 4),
        p_mean_bar: roundOrNull(meanValue(points.map((pt) => ({ ts: pt.ts, value: pt.pressureBar }))), 4),
        t_mean_c: roundOrNull(tMean, 3),
        t_min_c: temps.length === 0 ? null : round(Math.min(...temps), 3),
        t_max_c: temps.length === 0 ? null : round(Math.max(...temps), 3),
        downstream_p_rise_bar: downStart === null || downEnd === null ? null : round(downEnd - downStart, 4),
      },
      conditions: { t_bin: tMean === null ? null : binFloor(tMean, p.tempBinWidthC) },
      dq,
      open: run.open,
      ...validity(run.open, dq.completeness, p.minCompleteness),
    };
  });
}
