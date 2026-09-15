// P3 평가 프리셋: 수소 저장·압축기·전해조 비에너지·연료전지 블로워·태양광 오염·랙 저항·인버터 냉각팬 고장의 크기 스윕과 P3 대조군.
// 실행 순번 i마다 각 스윕의 i번째 크기를 넣는다(null이면 그 순번에 없음). 서로 헷갈리게 하는 고장은 같은 순번에 두지 않는다:
//   누설(0~6)·비에너지 상승(0~8) ↔ 유량계 드리프트(9~11) · 비에너지 경로는 순번마다 하나 · 밸브 마모(0~2) ↔ 씰 누설(3~5) · 블로워 마모(0~2) ↔ 필터 막힘(3~5).
//   유량계 드리프트는 측정 수소량을 키워 전해조 비에너지(kWh/kg) 상승을 가리므로 비에너지 스윕과도 겹치지 않게 한다.
// 대조군 사이트 SIM-C에는 P3 대조군만 넣는다(P2 평가 잡과 다른 잡). 고장이 없는 순번의 SIM-A는 실행하지 않는다.
import type { ElzSecRiseMode } from './fault-scenarios-p3';
import type { Scenario } from './scenarios';

const SIM_C = 'SIM-C';

export interface SecRiseMagnitude {
  readonly mode: ElzSecRiseMode;
  readonly pct: number;
}

export const EVAL_P3_PRESET = Object.freeze({
  /** 고장 시작일: 앞 120일은 기준선 */
  faultStartDay: 120,
  runs: 12,
  targets: { rack: 'ESS1/RACK02', inverter: 'PV1/INV02', tank: 'H2BANK1/TANK2' },
  sweeps: {
    /** SIM-A 전 인버터 끈적한 오염층 [%/일] */
    pvSoilingPctPerDay: [0.02, 0.05, 0.1, 0.2],
    /** SIM-A 랙 2 내부저항 [%] (60일 램프) */
    rackResistancePct: [10, 20, 35, 50],
    /** SIM-A 인버터 2 냉각팬 고장 시작일 (겨울·봄·여름 시작 → 저감이 보이기까지의 지연 비교) */
    inverterFanFailureStartDay: [120, 200, 280],
    /** SIM-B 용기 2 누설 [kg/일] */
    tankLeakKgPerDay: [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5],
    /** SIM-B 전해조 비에너지 상승 경로·크기 [%] (60일 램프) */
    elzSecRise: [
      { mode: 'rectifier', pct: 3 },
      { mode: 'rectifier', pct: 6 },
      { mode: 'rectifier', pct: 10 },
      { mode: 'faradaic', pct: 3 },
      { mode: 'faradaic', pct: 6 },
      { mode: 'faradaic', pct: 10 },
      { mode: 'stack', pct: 3 },
      { mode: 'stack', pct: 6 },
      { mode: 'stack', pct: 10 },
    ] satisfies readonly SecRiseMagnitude[],
    /** SIM-B 압축기 밸브 마모 [%] (60일 램프) */
    compressorValveWearPct: [5, 10, 20],
    /** SIM-B 압축기 씰 누설 감지 압력 상승률 [bar/일] */
    compressorSealLeakBarPerDay: [null, null, null, 0.02, 0.05, 0.1],
    /** SIM-B 연료전지 블로워 마모 [%/월] */
    fcBlowerWearPctPerMonth: [2, 5, 10],
    /** SIM-B 공기 필터 막힘 [%] (60일 램프, 330일째 교체) */
    fcAirFilterClogPct: [null, null, null, 10, 25, 40],
    /** SIM-B 전해조 유량계 드리프트 [%/월] */
    flowmeterDriftPctPerMonth: [null, null, null, null, null, null, null, null, null, 1, 2, 4],
  },
  /** 오염 고장 강한 비 (고장 시작 뒤 60일 간격) */
  pvSoilingRainDays: [180, 240, 300],
  fcAirFilterCleanedDay: 330,
  /** 대조군 사이트 SIM-C의 P3 음성 조건 (healthy_mass_balance 구간에는 다른 조건을 겹치지 않는다) */
  controls: [
    { kind: 'control.compressor_high_ratio_week', site: SIM_C, startDay: 60 },
    { kind: 'control.tank_refill_topoff', site: SIM_C, startDay: 90 },
    { kind: 'control.healthy_mass_balance', site: SIM_C, startDay: 130, days: 30 },
    { kind: 'control.day_night_swing', site: SIM_C, startDay: 200 },
    { kind: 'control.elz_part_load_week', site: SIM_C, startDay: 240 },
    { kind: 'control.rainy_week', site: SIM_C, startDay: 270 },
    { kind: 'control.hot_week', site: SIM_C, startDay: 305 },
  ] satisfies readonly Scenario[],
});

export type EvalP3Preset = typeof EVAL_P3_PRESET;

export interface P3EvalMagnitudes {
  readonly pvSoilingPctPerDay: number | null;
  readonly rackResistancePct: number | null;
  readonly inverterFanFailureStartDay: number | null;
  readonly tankLeakKgPerDay: number | null;
  readonly elzSecRise: SecRiseMagnitude | null;
  readonly compressorValveWearPct: number | null;
  readonly compressorSealLeakBarPerDay: number | null;
  readonly fcBlowerWearPctPerMonth: number | null;
  readonly fcAirFilterClogPct: number | null;
  readonly flowmeterDriftPctPerMonth: number | null;
}

export function p3MagnitudesAt(preset: EvalP3Preset, i: number): P3EvalMagnitudes {
  const { sweeps } = preset;
  return {
    pvSoilingPctPerDay: sweeps.pvSoilingPctPerDay[i] ?? null,
    rackResistancePct: sweeps.rackResistancePct[i] ?? null,
    inverterFanFailureStartDay: sweeps.inverterFanFailureStartDay[i] ?? null,
    tankLeakKgPerDay: sweeps.tankLeakKgPerDay[i] ?? null,
    elzSecRise: sweeps.elzSecRise[i] ?? null,
    compressorValveWearPct: sweeps.compressorValveWearPct[i] ?? null,
    compressorSealLeakBarPerDay: sweeps.compressorSealLeakBarPerDay[i] ?? null,
    fcBlowerWearPctPerMonth: sweeps.fcBlowerWearPctPerMonth[i] ?? null,
    fcAirFilterClogPct: sweeps.fcAirFilterClogPct[i] ?? null,
    flowmeterDriftPctPerMonth: sweeps.flowmeterDriftPctPerMonth[i] ?? null,
  };
}

const when = <T>(value: T | null, build: (v: T) => Scenario): Scenario[] => (value === null ? [] : [build(value)]);

function simAFaults(preset: EvalP3Preset, m: P3EvalMagnitudes): Scenario[] {
  const { faultStartDay: startDay, targets } = preset;
  return [
    ...when(m.pvSoilingPctPerDay, (pctPerDay) => ({ kind: 'fault.pv_soiling', site: 'SIM-A', pctPerDay, startDay, rainDays: preset.pvSoilingRainDays })),
    ...when(m.rackResistancePct, (pct) => ({ kind: 'fault.rack_resistance_growth', site: 'SIM-A', rack: targets.rack, pct, startDay })),
    ...when(m.inverterFanFailureStartDay, (day) => ({ kind: 'fault.inverter_fan_failure', site: 'SIM-A', inverter: targets.inverter, startDay: day })),
  ];
}

function simBFaults(preset: EvalP3Preset, m: P3EvalMagnitudes): Scenario[] {
  const { faultStartDay: startDay, targets } = preset;
  return [
    ...when(m.tankLeakKgPerDay, (kgPerDay) => ({ kind: 'fault.tank_leak', site: 'SIM-B', tank: targets.tank, kgPerDay, startDay })),
    ...when(m.flowmeterDriftPctPerMonth, (pctPerMonth) => ({ kind: 'fault.flowmeter_drift', site: 'SIM-B', pctPerMonth, startDay })),
    ...when(m.elzSecRise, (sec) => ({ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: sec.mode, pct: sec.pct, startDay })),
    ...when(m.compressorValveWearPct, (pct) => ({ kind: 'fault.compressor_valve_wear', site: 'SIM-B', pct, startDay })),
    ...when(m.compressorSealLeakBarPerDay, (rate) => ({ kind: 'fault.compressor_leak_seal', site: 'SIM-B', rate, startDay })),
    ...when(m.fcBlowerWearPctPerMonth, (pctPerMonth) => ({ kind: 'fault.fc_blower_wear', site: 'SIM-B', pctPerMonth, startDay })),
    ...when(m.fcAirFilterClogPct, (pct) => ({ kind: 'fault.fc_air_filter_clog', site: 'SIM-B', pct, startDay, cleanedDay: preset.fcAirFilterCleanedDay })),
  ];
}

export interface P3RunScenarios {
  readonly magnitudes: P3EvalMagnitudes;
  readonly siteCodes: readonly string[];
  readonly scenarios: readonly Scenario[];
}

/** 순번 i의 P3 실행: 고장이 있는 사이트와 대조군 SIM-C */
export function p3RunScenarios(preset: EvalP3Preset, i: number): P3RunScenarios {
  const magnitudes = p3MagnitudesAt(preset, i);
  const simA = simAFaults(preset, magnitudes);
  const simB = simBFaults(preset, magnitudes);
  const siteCodes = [...(simA.length > 0 ? ['SIM-A'] : []), ...(simB.length > 0 ? ['SIM-B'] : []), SIM_C];
  return { magnitudes, siteCodes, scenarios: [...simA, ...simB, ...preset.controls] };
}
