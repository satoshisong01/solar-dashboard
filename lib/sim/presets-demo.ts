// 개발 DB 데모 프리셋 'demo'의 P3 추가분 (120일, 일수는 적재 시작일 기준). P2 demo120 주입은 presets.ts가 앞에 붙인다.
import type { Scenario } from './scenarios';

/**
 * tank.static_leak 안전 임계 [kg/일] — 탐지기 기본 safetyKgPerDay(0.5)와 같은 값으로 둔다(탐지기 기본값이 바뀌면 함께 바꾼다).
 * 탐지기는 누설률 95% CI 하한이 이 값을 넘을 때만 safety(severity 4)로 올리므로 데모 누설은 이 값의 2배(1 kg/일)로 키운다.
 * 용기 1기(1,850 L·450 bar, 약 53 kg) 기준 약 1%/일, 표준상태 약 3.9 NL/min.
 */
export const DEMO_TANK_LEAK_SAFETY_KG_PER_DAY = 0.5;

export const DEMO_P3 = Object.freeze({
  pvSoiling: { pctPerDay: 0.08, startDay: 0, rainDays: [45, 85] },
  rackResistance: { rack: 'ESS1/RACK02', pct: 45, startDay: 50, rampDays: 60 },
  inverterFan: { inverter: 'PV1/INV02', startDay: 40 },
  tankLeak: { tank: 'H2BANK1/TANK3', kgPerDay: 0.05, startDay: 60, escalationDay: 90, escalationKgPerDay: 2 * DEMO_TANK_LEAK_SAFETY_KG_PER_DAY },
  compressorValveWear: { pct: 12, startDay: 40, rampDays: 60 },
  elzSecRise: { mode: 'rectifier', pct: 6, startDay: 45, rampDays: 60 },
  fcAirFilterClog: { pct: 25, startDay: 40, rampDays: 45, cleanedDay: 100 },
  simC: { hotWeekDay: 98, dayNightSwingDay: 110 },
} as const);

/**
 * - SIM-A: 전 인버터 끈적한 오염 0.08%/일(45·85일째 강한 비로 복원), 랙 2 저항 +45%(50일째부터 60일 램프), 인버터 2 냉각팬 고장(40일째)
 * - SIM-B: 용기 3 누설 60일째 0.05 kg/일 → 90일째 안전 임계의 2배, 압축기 밸브 마모 +12%(40일째부터 60일 램프),
 *          전해조 비에너지 +6% 정류기 경로(45일째부터 60일 램프), 연료전지 공기 필터 막힘 블로워 +25%(40일째부터 45일 램프, 100일째 필터 교체)
 * - SIM-C: 고온 주(98일째)·일교차 확대(110일째)
 */
export function demoP3Scenarios(): readonly Scenario[] {
  const d = DEMO_P3;
  return [
    { kind: 'fault.pv_soiling', site: 'SIM-A', pctPerDay: d.pvSoiling.pctPerDay, startDay: d.pvSoiling.startDay, rainDays: d.pvSoiling.rainDays },
    { kind: 'fault.rack_resistance_growth', site: 'SIM-A', ...d.rackResistance },
    { kind: 'fault.inverter_fan_failure', site: 'SIM-A', ...d.inverterFan },
    {
      kind: 'fault.tank_leak',
      site: 'SIM-B',
      tank: d.tankLeak.tank,
      kgPerDay: d.tankLeak.kgPerDay,
      startDay: d.tankLeak.startDay,
      escalations: [{ day: d.tankLeak.escalationDay, kgPerDay: d.tankLeak.escalationKgPerDay }],
    },
    { kind: 'fault.compressor_valve_wear', site: 'SIM-B', ...d.compressorValveWear },
    { kind: 'fault.elz_sec_rise', site: 'SIM-B', ...d.elzSecRise },
    { kind: 'fault.fc_air_filter_clog', site: 'SIM-B', ...d.fcAirFilterClog },
    { kind: 'control.hot_week', site: 'SIM-C', startDay: d.simC.hotWeekDay },
    { kind: 'control.day_night_swing', site: 'SIM-C', startDay: d.simC.dayNightSwingDay },
  ];
}
