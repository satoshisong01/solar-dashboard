// ESS 랙 전류 계단 에피소드: ess.current_step@1 (ess.resistance_growth 입력).
// 계단 = 이웃한 두 전류 샘플(간격 ≤ 1.5 × 공칭 주기) 차이 |ΔI| ≥ minStepC × 정격 Ah, 계단 앞·뒤 샘플 간 전류 변화는 |ΔI| × quietRatio 이하(깨끗한 계단).
// R_step = ΔV / ΔI [mΩ] (두 샘플과 같은 시각의 랙 전압). 샘플 간격 동안의 분극이 섞이므로 값은 샘플 주기에 의존한다 → period_s를 함께 저장하고
// 탐지기는 같은 주기끼리만 비교한다 (R_60s 등).
// 입력 메트릭 (랙): batt.current(A, 충전 +, 필수) · batt.voltage(V, 필수) · batt.soc(%) · cell.temp.avg(°C) · cell.voltage.max/min(V)
import { MS_PER_SECOND } from '../types';
import { binFloor, goodPoints, nominalPeriodMs, pointsIn, round, roundOrNull, valueNear, type TimedValue } from './series';
import { extractorId, type Episode, type ExtractInput } from './types';
import type { EssRackNameplate } from './ess';

export interface EssStepParams {
  readonly minStepC: number;
  readonly quietRatio: number;
  readonly fallbackPeriodS: number;
  readonly socBinWidth: number;
  readonly tempBinWidthC: number;
}

export const DEFAULT_ESS_STEP_PARAMS: EssStepParams = Object.freeze({ minStepC: 0.05, quietRatio: 0.25, fallbackPeriodS: 60, socBinWidth: 10, tempBinWidthC: 5 });

export type EssStepFeatures = {
  readonly r_mohm: number;
  readonly delta_i_a: number;
  readonly delta_i_c: number;
  readonly delta_v_v: number;
  readonly i_before_a: number;
  readonly i_after_a: number;
  readonly soc: number | null;
  readonly t_cell_c: number | null;
  readonly period_s: number;
  readonly cell_dv_mv: number | null;
};
export type EssStepConditions = { readonly soc_bin: number | null; readonly t_bin: number | null; readonly direction: 'up' | 'down' };
export type EssStepEpisode = Episode<'ess.current_step', EssStepFeatures, EssStepConditions>;

interface Signals {
  readonly voltage: readonly TimedValue[];
  readonly soc: readonly TimedValue[];
  readonly temp: readonly TimedValue[];
  readonly cellMax: readonly TimedValue[];
  readonly cellMin: readonly TimedValue[];
}

const quiet = (a: TimedValue | undefined, b: TimedValue | undefined, limitA: number, maxGapMs: number): boolean => a !== undefined && b !== undefined && b.ts - a.ts <= maxGapMs && Math.abs(b.value - a.value) <= limitA;

function stepEpisode(input: ExtractInput<EssRackNameplate>, signals: Signals, before: TimedValue, after: TimedValue, p: EssStepParams, toleranceMs: number): EssStepEpisode[] {
  const vBefore = valueNear(signals.voltage, before.ts, toleranceMs);
  const vAfter = valueNear(signals.voltage, after.ts, toleranceMs);
  const deltaI = after.value - before.value;
  if (vBefore === null || vAfter === null) return [];
  const rOhm = (vAfter - vBefore) / deltaI;
  if (!(rOhm > 0)) return [];
  const soc = valueNear(signals.soc, before.ts, 2 * toleranceMs);
  const temp = valueNear(signals.temp, before.ts, 5 * toleranceMs);
  const cellMax = valueNear(signals.cellMax, after.ts, toleranceMs);
  const cellMin = valueNear(signals.cellMin, after.ts, toleranceMs);
  return [
    {
      assetId: input.assetId,
      kind: 'ess.current_step',
      extractorVersion: extractorId('ess.current_step'),
      start: before.ts,
      end: after.ts,
      features: {
        r_mohm: round(rOhm * 1000, 4),
        delta_i_a: round(deltaI, 3),
        delta_i_c: round(deltaI / input.nameplate.capacity_ah, 5),
        delta_v_v: round(vAfter - vBefore, 4),
        i_before_a: round(before.value, 3),
        i_after_a: round(after.value, 3),
        soc: roundOrNull(soc, 3),
        t_cell_c: roundOrNull(temp, 3),
        period_s: Math.round((after.ts - before.ts) / MS_PER_SECOND),
        cell_dv_mv: cellMax === null || cellMin === null ? null : round((cellMax - cellMin) * 1000, 3),
      },
      conditions: { soc_bin: soc === null ? null : binFloor(soc, p.socBinWidth), t_bin: temp === null ? null : binFloor(temp, p.tempBinWidthC), direction: deltaI > 0 ? 'up' : 'down' },
      dq: { completeness: 1, missing_ratio: 0, bad_ratio: 0 },
      open: false,
      valid: true,
      invalidReason: null,
    },
  ];
}

/** 원시 샘플 → ess.current_step 에피소드 (계단 앞 샘플이 창 안인 것만) */
export function extractCurrentSteps(input: ExtractInput<EssRackNameplate>, overrides: Partial<EssStepParams> = {}): EssStepEpisode[] {
  const p = { ...DEFAULT_ESS_STEP_PARAMS, ...overrides };
  if (!(input.nameplate.capacity_ah > 0)) throw new RangeError(`ess.current_step 추출: 정격 용량이 올바르지 않습니다 (${input.nameplate.capacity_ah})`);
  const current = goodPoints(input.series, 'batt.current');
  const periodMs = nominalPeriodMs(current, p.fallbackPeriodS * MS_PER_SECOND);
  const maxGapMs = 1.5 * periodMs;
  const toleranceMs = periodMs / 4;
  const signals: Signals = {
    voltage: goodPoints(input.series, 'batt.voltage'),
    soc: goodPoints(input.series, 'batt.soc'),
    temp: goodPoints(input.series, 'cell.temp.avg'),
    cellMax: goodPoints(input.series, 'cell.voltage.max'),
    cellMin: goodPoints(input.series, 'cell.voltage.min'),
  };
  const minStepA = p.minStepC * input.nameplate.capacity_ah;
  const inWindow = new Set(pointsIn(current, input.window).map((pt) => pt.ts));
  return current.flatMap((after, i) => {
    const before = current[i - 1];
    if (!before || !inWindow.has(before.ts) || after.ts - before.ts > maxGapMs) return [];
    const deltaA = Math.abs(after.value - before.value);
    if (deltaA < minStepA) return [];
    const limitA = p.quietRatio * deltaA;
    if (!quiet(current[i - 2], before, limitA, maxGapMs) || !quiet(after, current[i + 1], limitA, maxGapMs)) return [];
    return stepEpisode(input, signals, before, after, p, toleranceMs);
  });
}
