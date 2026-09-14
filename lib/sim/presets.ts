// 시나리오 프리셋.
// - 적재 스크립트(sim:backfill)용: healthy · dq(적재 구간에 비례한 날짜의 KST 시각) · demo120(일수 기반 고장·대조군 데모)
// - 평가(sim:eval)용: EVAL_PRESET 크기 스윕과 evalRunPlans
import { KST_OFFSET_MS, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import type { Scenario } from './scenarios';

export const SCENARIO_PRESETS = ['healthy', 'dq', 'demo120'] as const;
export type ScenarioPreset = (typeof SCENARIO_PRESETS)[number];

/** dq 프리셋의 구간 배치가 서로 겹치지 않고 적재 구간 안에 들어가는 최소 일수 */
export const DQ_MIN_DAYS = 3;
const DQ_REQUIRED_SITES = ['SIM-A', 'SIM-B'] as const;
const HOUR_S = 3_600;

export interface PresetWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

const kstDayStart = (ms: number): number => Math.floor((ms + KST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - KST_OFFSET_MS;

/** 구간의 fraction 지점이 속한 KST 날짜의 kstHour 시각. 구간 밖이면 하루 당기거나 민다. */
function placeAt(window: PresetWindow, fraction: number, kstHour: number): number {
  const pivot = window.fromMs + (window.toMs - window.fromMs) * fraction;
  const candidate = kstDayStart(pivot) + kstHour * MS_PER_HOUR;
  if (candidate < window.fromMs) return candidate + MS_PER_DAY;
  if (candidate >= window.toMs) return candidate - MS_PER_DAY;
  return candidate;
}

/**
 * 데이터 품질 프리셋 (설계 §5.5):
 * - 선택한 모든 사이트 중복 배치 5% (저장값이 바뀌지 않으므로 대조군 SIM-C에도 적용)
 * - SIM-A: 일사계(WX1/POA) 8시간 고착, +200초 시계 오차 12시간 구간
 * - SIM-B: 게이트웨이 6시간 단절 후 역순 백필, 저장탱크 압력 스파이크(하루 1회꼴), 수소 누출 1차 경보 1회
 * 값을 바꾸는 시나리오는 대조군 SIM-C에 넣지 않는다.
 */
function dqScenarios(siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  const missing = DQ_REQUIRED_SITES.filter((code) => !siteCodes.includes(code));
  if (missing.length > 0) throw new Error(`dq 시나리오에는 ${DQ_REQUIRED_SITES.join('·')}가 필요합니다 (빠진 사이트: ${missing.join(', ')})`);
  if (window.toMs - window.fromMs < DQ_MIN_DAYS * MS_PER_DAY) throw new Error(`dq 시나리오는 ${DQ_MIN_DAYS}일 이상 적재할 때만 쓸 수 있습니다`);

  return [
    ...siteCodes.map((site): Scenario => ({ kind: 'dq.duplicate_batches', site, ratio: 0.05 })),
    { kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA', start: placeAt(window, 0.2, 9), durationS: 8 * HOUR_S },
    { kind: 'dq.gateway_outage', site: 'SIM-B', start: placeAt(window, 0.4, 10), durationS: 6 * HOUR_S },
    { kind: 'dq.clock_skew', site: 'SIM-A', skewS: 200, start: placeAt(window, 0.6, 18), durationS: 12 * HOUR_S },
    { kind: 'dq.spike', site: 'SIM-B', sourceKey: 'H2BANK1/TANK1/P', perDay: 1 },
    { kind: 'safety.h2_leak_alarm', site: 'SIM-B', at: placeAt(window, 0.8, 14) + 30 * MS_PER_MINUTE },
  ];
}

export const DEMO120_DAYS = 120;
const ALL_SIM_SITES = ['SIM-A', 'SIM-B', 'SIM-C'] as const;

/**
 * 개발 DB 데모 프리셋 (120일, 일수는 적재 시작일 기준):
 * - SIM-A: 랙 1 용량 45일째부터 30일간 총 −7%, 인버터 1 효율 60일째부터 −2%p, 랙 3 셀 불균형 30일째부터 월 10 mV
 * - SIM-B: 전해조 스택 30일째부터 25 µV/h, 연료전지 30일째부터 30 µV/h, 90일째 SOC 상한 90% → 80% (대조군)
 * - SIM-C: 고장 없음 + 한파 주간(20일째)·흐린 주(50일째)·출력제어 3회(70·77·84일째)
 */
function demo120Scenarios(siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  const missing = ALL_SIM_SITES.filter((code) => !siteCodes.includes(code));
  if (missing.length > 0) throw new Error(`demo120 시나리오에는 ${ALL_SIM_SITES.join('·')}가 필요합니다 (빠진 사이트: ${missing.join(', ')})`);
  if (window.toMs - window.fromMs < DEMO120_DAYS * MS_PER_DAY) throw new Error(`demo120 시나리오는 ${DEMO120_DAYS}일 이상 적재할 때만 쓸 수 있습니다`);

  return [
    { kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay: 45, totalPct: 7, days: 30 },
    { kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV01', pctPoints: 2, startDay: 60 },
    { kind: 'fault.cell_imbalance', site: 'SIM-A', asset: 'ESS1/RACK03', mVPerMonth: 10, startDay: 30 },
    { kind: 'fault.elz_stack_degradation', site: 'SIM-B', uvPerH: 25, startDay: 30 },
    { kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: 30, startDay: 30 },
    { kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 90, newLimit: 0.8 },
    { kind: 'control.cold_week', site: 'SIM-C', startDay: 20 },
    { kind: 'control.cloudy_week', site: 'SIM-C', startDay: 50 },
    { kind: 'control.curtailment', site: 'SIM-C', startDay: 70, count: 3 },
  ];
}

export function presetScenarios(preset: ScenarioPreset, siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  switch (preset) {
    case 'healthy':
      return [];
    case 'dq':
      return dqScenarios(siteCodes, window);
    case 'demo120':
      return demo120Scenarios(siteCodes, window);
  }
}

/** 평가 프리셋 (설계 §5.5): 1년 × 3사이트를 메모리 모드로 돌려 크기별 재현율·지연·크기 오차·대조군 오탐을 잰다. */
export const EVAL_PRESET = Object.freeze({
  days: 365,
  /** 기준일. SIM-B·C 준공(2025-09-01) 한 달 뒤 */
  from: '2025-10-01T00:00:00+09:00',
  seeds: [101, 202, 303],
  /** 고장 시작일: 앞 120일은 기준선 */
  faultStartDay: 120,
  capacityFadeDays: 30,
  sweeps: {
    capacityFadePct: [1, 3, 5, 7, 10],
    elzUvPerH: [5, 10, 20, 40],
    fcUvPerH: [5, 10, 20, 40],
    inverterDropPctPoints: [0.5, 1, 2, 3],
  },
  /** 대조군 사이트 SIM-C의 음성 조건 */
  controls: [
    { kind: 'control.cold_week', site: 'SIM-C', startDay: 100 },
    { kind: 'control.cloudy_week', site: 'SIM-C', startDay: 160 },
    { kind: 'control.curtailment', site: 'SIM-C', startDay: 190, count: 3 },
    { kind: 'control.elz_part_load_week', site: 'SIM-C', startDay: 230 },
    { kind: 'control.fc_frequent_start_stop', site: 'SIM-C', startDay: 260 },
    { kind: 'control.soc_upper_limit_change', site: 'SIM-C', asset: 'ESS1', day: 300, newLimit: 0.8 },
  ] satisfies readonly Scenario[],
});

export type EvalPreset = typeof EVAL_PRESET;

export interface EvalMagnitudes {
  readonly capacityFadePct: number | null;
  readonly elzUvPerH: number | null;
  readonly fcUvPerH: number | null;
  readonly inverterDropPctPoints: number | null;
}

export interface EvalRunPlan {
  readonly id: string;
  readonly seed: number;
  readonly from: string;
  readonly days: number;
  readonly siteCodes: readonly string[];
  readonly magnitudes: EvalMagnitudes;
  readonly scenarios: readonly Scenario[];
}

/**
 * 시드 × 스윕 순번마다 실행 하나. 순번 i에서 각 스윕의 i번째 크기를 설비 하나에만 넣는다
 * (동종 비교 기준이 남도록 SIM-A 랙·인버터는 1대씩, 목록이 짧은 스윕은 그 순번에 고장 없음).
 */
export function evalRunPlans(preset: EvalPreset = EVAL_PRESET): readonly EvalRunPlan[] {
  const { sweeps, faultStartDay: startDay } = preset;
  const runs = Math.max(...Object.values(sweeps).map((values) => values.length));
  return preset.seeds.flatMap((seed) =>
    Array.from({ length: runs }, (_, i): EvalRunPlan => {
      const magnitudes: EvalMagnitudes = {
        capacityFadePct: sweeps.capacityFadePct[i] ?? null,
        elzUvPerH: sweeps.elzUvPerH[i] ?? null,
        fcUvPerH: sweeps.fcUvPerH[i] ?? null,
        inverterDropPctPoints: sweeps.inverterDropPctPoints[i] ?? null,
      };
      const faults: Scenario[] = [
        ...(magnitudes.capacityFadePct === null ? [] : [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay, totalPct: magnitudes.capacityFadePct, days: preset.capacityFadeDays } as const]),
        ...(magnitudes.inverterDropPctPoints === null ? [] : [{ kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV01', pctPoints: magnitudes.inverterDropPctPoints, startDay } as const]),
        ...(magnitudes.elzUvPerH === null ? [] : [{ kind: 'fault.elz_stack_degradation', site: 'SIM-B', uvPerH: magnitudes.elzUvPerH, startDay } as const]),
        ...(magnitudes.fcUvPerH === null ? [] : [{ kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: magnitudes.fcUvPerH, startDay } as const]),
      ];
      return { id: `eval-s${seed}-${i + 1}`, seed, from: preset.from, days: preset.days, siteCodes: ALL_SIM_SITES, magnitudes, scenarios: [...faults, ...preset.controls] };
    }),
  );
}
