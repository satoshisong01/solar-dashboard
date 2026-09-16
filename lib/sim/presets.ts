// 시나리오 프리셋.
// - 적재 스크립트(sim:backfill)용: healthy · dq(적재 구간에 비례한 날짜의 KST 시각) · demo120(P2 고장·대조군 데모) · demo(demo120 + P3, presets-demo.ts)
// - 평가(sim:eval)용: EVAL_PRESET 크기 스윕과 evalRunPlans (P2 순번 뒤에 P3 순번, presets-eval-p3.ts)
import { KST_OFFSET_MS, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { demoP3Scenarios } from './presets-demo';
import { EVAL_GAPYEONG_PRESET, gapyeongRunCount, gapyeongRunScenarios, type GapyeongEvalMagnitudes } from './presets-eval-gapyeong';
import { EVAL_P3_PRESET, p3RunScenarios, type P3EvalMagnitudes } from './presets-eval-p3';
import type { Scenario } from './scenarios';

export const SCENARIO_PRESETS = ['healthy', 'dq', 'demo120', 'demo'] as const;
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
export const DEMO_DAYS = DEMO120_DAYS;
const ALL_SIM_SITES = ['SIM-A', 'SIM-B', 'SIM-C'] as const;

/**
 * 개발 DB 데모 프리셋 (120일, 일수는 적재 시작일 기준):
 * - SIM-A: 랙 1 용량 45일째부터 30일간 총 −7%, 인버터 1 효율 60일째부터 −2%p, 랙 3 셀 불균형 30일째부터 월 10 mV
 * - SIM-B: 전해조 스택 30일째부터 25 µV/h, 연료전지 30일째부터 30 µV/h, 90일째 SOC 상한 90% → 80% (대조군)
 * - SIM-C: 고장 없음 + 한파 주간(20일째)·흐린 주(50일째)·출력제어 3회(70·77·84일째)
 */
function requireDemoWindow(name: string, siteCodes: readonly string[], window: PresetWindow): void {
  const missing = ALL_SIM_SITES.filter((code) => !siteCodes.includes(code));
  if (missing.length > 0) throw new Error(`${name} 시나리오에는 ${ALL_SIM_SITES.join('·')}가 필요합니다 (빠진 사이트: ${missing.join(', ')})`);
  if (window.toMs - window.fromMs < DEMO120_DAYS * MS_PER_DAY) throw new Error(`${name} 시나리오는 ${DEMO120_DAYS}일 이상 적재할 때만 쓸 수 있습니다`);
}

function demo120Scenarios(siteCodes: readonly string[], window: PresetWindow): readonly Scenario[] {
  requireDemoWindow('demo120', siteCodes, window);

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
    case 'demo':
      requireDemoWindow('demo', siteCodes, window);
      return [...demo120Scenarios(siteCodes, window), ...demoP3Scenarios()];
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
    /** SIM-A 랙 1 (태양광+ESS, 매일 SOC 10~90% 사이클) */
    capacityFadePct: [1, 3, 5, 7, 10],
    /** SIM-B 랙 1 (연계형: 전해조 뒤 남는 전력으로만 부분 충전) */
    integratedCapacityFadePct: [1, 3, 5, 7, 10],
    /** SIM-A 랙 3 셀 전압 산포 증가 [mV/월] */
    cellSpreadMvPerMonth: [5, 10, 20],
    /** 데이터 품질 결측(샘플 제거)·고착(값 고정) 길이 [h] — SIM-A 일사계·외기온도, SIM-B 배터리실 온도·모듈 온도 */
    dqHours: [3, 6, 12],
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
  /** P3 고장 스윕·대조군 (P2 순번 뒤에 붙는다) */
  p3: EVAL_P3_PRESET,
  /** 가평 구성 고장 스윕 (P3 순번 뒤에 붙는다, SIM-D) */
  gapyeong: EVAL_GAPYEONG_PRESET,
});

export type EvalPreset = typeof EVAL_PRESET;

export interface EvalMagnitudes {
  readonly capacityFadePct: number | null;
  readonly integratedCapacityFadePct: number | null;
  readonly cellSpreadMvPerMonth: number | null;
  readonly dqHours: number | null;
  readonly elzUvPerH: number | null;
  readonly fcUvPerH: number | null;
  readonly inverterDropPctPoints: number | null;
  /** P3 실행이면 P3 크기 (P2 크기는 모두 null) */
  readonly p3: P3EvalMagnitudes | null;
  /** 가평 구성 실행이면 그 크기 (P2·P3 크기는 모두 null) */
  readonly gapyeong?: GapyeongEvalMagnitudes | null;
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
 * 데이터 품질 평가 주입 (순번 i마다 100일씩 뒤로 옮겨 계절을 바꾼다, 대조군 SIM-C에는 넣지 않는다):
 * SIM-A 일사계 POA 고착(40일째 09시)·외기온도 결측(47일째 10시), SIM-B 배터리실 온도 고착(54일째 09시)·모듈 온도 결측(61일째 13시)
 */
function dqEvalScenarios(from: string, hours: number, i: number): Scenario[] {
  const at = (day: number, kstHour: number): number => Date.parse(from) + (day + 100 * i) * MS_PER_DAY + kstHour * MS_PER_HOUR;
  const durationS = hours * HOUR_S;
  return [
    { kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA', start: at(40, 9), durationS },
    { kind: 'dq.sample_loss', site: 'SIM-A', sourceKey: 'WX1/T_AMB', start: at(47, 10), durationS },
    { kind: 'dq.stuck_sensor', site: 'SIM-B', sourceKey: 'ESS1/T_ROOM', start: at(54, 9), durationS },
    { kind: 'dq.sample_loss', site: 'SIM-B', sourceKey: 'WX1/T_MOD', start: at(61, 13), durationS },
  ];
}

const NO_P2_MAGNITUDES: Omit<EvalMagnitudes, 'p3'> = {
  capacityFadePct: null,
  integratedCapacityFadePct: null,
  cellSpreadMvPerMonth: null,
  dqHours: null,
  elzUvPerH: null,
  fcUvPerH: null,
  inverterDropPctPoints: null,
};

/** 시드마다 P3 순번 실행 (id eval-s{시드}-p3-{순번}) */
function p3RunPlans(preset: EvalPreset, seed: number): EvalRunPlan[] {
  return Array.from({ length: preset.p3.runs }, (_, i): EvalRunPlan => {
    const run = p3RunScenarios(preset.p3, i);
    return { id: `eval-s${seed}-p3-${i + 1}`, seed, from: preset.from, days: preset.days, siteCodes: run.siteCodes, magnitudes: { ...NO_P2_MAGNITUDES, p3: run.magnitudes }, scenarios: run.scenarios };
  });
}

/**
 * 시드마다 P2 순번(스윕 길이 중 가장 긴 것) 뒤에 P3 순번(presets-eval-p3.ts). P2 순번 i에서 각 스윕의 i번째 크기를 설비 하나에만 넣는다
 * (동종 비교 기준이 남도록 랙·인버터는 1대씩 — SIM-A 랙 1 용량·랙 3 셀 불균형, SIM-B 랙 1 용량 — 목록이 짧은 스윕은 그 순번에 고장 없음).
 */
export function evalRunPlans(preset: EvalPreset = EVAL_PRESET): readonly EvalRunPlan[] {
  return preset.seeds.flatMap((seed) => [...p2RunPlans(preset, seed), ...p3RunPlans(preset, seed), ...gapyeongRunPlans(preset, seed)]);
}

/** 가평 구성 순번 (SIM-D 한 사이트. 고장이 없는 순번은 계획을 만들지 않는다) */
function gapyeongRunPlans(preset: EvalPreset, seed: number): EvalRunPlan[] {
  return Array.from({ length: gapyeongRunCount(preset.gapyeong) }, (_, i) => gapyeongRunScenarios(preset.gapyeong, i))
    .map((run, i): EvalRunPlan | null =>
      run.siteCodes.length === 0
        ? null
        : { id: `eval-s${seed}-gp-${i + 1}`, seed, from: preset.from, days: preset.days, siteCodes: run.siteCodes, magnitudes: { ...NO_P2_MAGNITUDES, p3: null, gapyeong: run.magnitudes }, scenarios: run.scenarios },
    )
    .filter((plan): plan is EvalRunPlan => plan !== null);
}

function p2RunPlans(preset: EvalPreset, seed: number): EvalRunPlan[] {
  const { sweeps, faultStartDay: startDay } = preset;
  const runs = Math.max(...Object.values(sweeps).map((values) => values.length));
  return Array.from({ length: runs }, (_, i): EvalRunPlan => {
    const magnitudes: EvalMagnitudes = {
      capacityFadePct: sweeps.capacityFadePct[i] ?? null,
      integratedCapacityFadePct: sweeps.integratedCapacityFadePct[i] ?? null,
      cellSpreadMvPerMonth: sweeps.cellSpreadMvPerMonth[i] ?? null,
      dqHours: sweeps.dqHours[i] ?? null,
      elzUvPerH: sweeps.elzUvPerH[i] ?? null,
      fcUvPerH: sweeps.fcUvPerH[i] ?? null,
      inverterDropPctPoints: sweeps.inverterDropPctPoints[i] ?? null,
      p3: null,
    };
    const faults: Scenario[] = [
      ...(magnitudes.capacityFadePct === null ? [] : [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay, totalPct: magnitudes.capacityFadePct, days: preset.capacityFadeDays } as const]),
      ...(magnitudes.inverterDropPctPoints === null ? [] : [{ kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV01', pctPoints: magnitudes.inverterDropPctPoints, startDay } as const]),
      ...(magnitudes.cellSpreadMvPerMonth === null ? [] : [{ kind: 'fault.cell_imbalance', site: 'SIM-A', asset: 'ESS1/RACK03', mVPerMonth: magnitudes.cellSpreadMvPerMonth, startDay } as const]),
      ...(magnitudes.integratedCapacityFadePct === null ? [] : [{ kind: 'fault.battery_capacity_fade', site: 'SIM-B', asset: 'ESS1/RACK01', startDay, totalPct: magnitudes.integratedCapacityFadePct, days: preset.capacityFadeDays } as const]),
      ...(magnitudes.elzUvPerH === null ? [] : [{ kind: 'fault.elz_stack_degradation', site: 'SIM-B', uvPerH: magnitudes.elzUvPerH, startDay } as const]),
      ...(magnitudes.fcUvPerH === null ? [] : [{ kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: magnitudes.fcUvPerH, startDay } as const]),
    ];
    const dq = magnitudes.dqHours === null ? [] : dqEvalScenarios(preset.from, magnitudes.dqHours, i);
    return { id: `eval-s${seed}-${i + 1}`, seed, from: preset.from, days: preset.days, siteCodes: ALL_SIM_SITES, magnitudes, scenarios: [...faults, ...dq, ...preset.controls] };
  });
}
