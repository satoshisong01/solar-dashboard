// 원장 테스트용 합성 입력 도우미 (테스트 전용).
import { kstDayStart, MS_PER_HOUR } from '../types';
import { LEMMON_EOS } from '../detectors/hydrogen-eos';
import type { LedgerAsset, LedgerHourRow } from './types';

/** 2026-06-15 KST 0시 */
export const DAY = kstDayStart(Date.UTC(2026, 5, 15, 3));

export const asset = (id: number, code: string, classKey: string, nameplate: Readonly<Record<string, unknown>> = {}): LedgerAsset => ({ id, code, classKey, nameplate });

/** 시간 행. hour는 DAY 기준 시간 번호(−1 = 전날 23시) */
export function row(assetId: number, metricKey: string, hour: number, value: number, extra: Partial<LedgerHourRow> = {}): LedgerHourRow {
  return { assetId, metricKey, hourStart: DAY + hour * MS_PER_HOUR, periodS: 60, n: 60, nGood: 60, avg: value, first: value, last: value, ...extra };
}

export const hoursOf = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

export const TANK_VOLUME_L = 1850;
export const TANK_COUNT = 4;

export interface H2DayScenario {
  /** 시간별 전해조 제품 수소 [kg/h] (24개) */
  readonly producedKgH: readonly number[];
  /** 시간별 연료전지 수소 소비 [kg/h] (24개) */
  readonly fcKgH: readonly number[];
  /** 하루 누설 [kg] — 24시간에 고르게 나눠 탱크에서 뺀다 */
  readonly leakKg: number;
  readonly startMassKg: number;
}

/** 탱크 가스 온도 [°C] (시간 번호별, 하루 사이 15~25 °C) */
const gasTempC = (hour: number): number => 20 + 5 * Math.sin((2 * Math.PI * (hour - 8)) / 24);
/** 탱크별 센서 오프셋 (시뮬레이터처럼 압력 ±0.4 bar, 온도 ±0.3 °C) */
const TANK_OFFSETS = [
  { bar: 0.4, c: -0.3 },
  { bar: -0.2, c: 0.2 },
  { bar: 0.1, c: 0.3 },
  { bar: -0.4, c: -0.1 },
] as const;

/**
 * 수소 설비(전해조·연료전지·탱크 4개) 설비와 하루 행. 탱크 압력은 같은 Abel–Noble 식으로 질량에서 만든다.
 * 시간 h 행의 first는 h시 시작 상태, last는 h+1시 시작 상태다.
 */
export function hydrogenScenario(scenario: H2DayScenario, firstId = 100): { readonly assets: LedgerAsset[]; readonly rows: LedgerHourRow[] } {
  const elzId = firstId;
  const fcId = firstId + 1;
  const tankIds = hoursOf(0, TANK_COUNT).map((i) => firstId + 10 + i);
  const assets = [
    asset(elzId, 'ELZ1', 'h2.elz', { rated_kw: 500 }),
    asset(fcId, 'FC1', 'fc.plant', { rated_kw: 200 }),
    ...tankIds.map((id, i) => asset(id, `H2BANK1/TANK${i + 1}`, 'h2.storage.tank', { water_volume_l: TANK_VOLUME_L })),
  ];
  const leakPerHour = scenario.leakKg / 24;
  const mass = [scenario.startMassKg];
  for (let h = 0; h < 24; h += 1) mass.push((mass[h] as number) + (scenario.producedKgH[h] ?? 0) - (scenario.fcKgH[h] ?? 0) - leakPerHour);
  const volumeM3 = (TANK_COUNT * TANK_VOLUME_L) / 1000;
  // 번호 −1 = 전날 23시 시작 상태 (그 시간에는 유입·유출 없이 누설만 있다고 본다)
  const massAt = (index: number): number => (index < 0 ? (mass[0] as number) + leakPerHour : (mass[index] as number));
  const pressure = (index: number, tank: number) => LEMMON_EOS.pressure(massAt(index), gasTempC(index), volumeM3) + TANK_OFFSETS[tank].bar;
  const temp = (index: number, tank: number) => gasTempC(index) + TANK_OFFSETS[tank].c;

  const tankRows = tankIds.flatMap((id, tank) =>
    hoursOf(-1, 24).flatMap((h) => {
      const start = h;
      const end = h + 1;
      return [
        row(id, 'tank.pressure', h, (pressure(start, tank) + pressure(end, tank)) / 2, { periodS: 300, n: 12, nGood: 12, first: pressure(start, tank), last: pressure(end, tank) }),
        row(id, 'tank.temp', h, (temp(start, tank) + temp(end, tank)) / 2, { periodS: 300, n: 12, nGood: 12, first: temp(start, tank), last: temp(end, tank) }),
      ];
    }),
  );
  const flowRows = hoursOf(-1, 24).flatMap((h) => [row(elzId, 'h2.flow.mass', h, scenario.producedKgH[h] ?? 0), row(fcId, 'fc.h2.consumption', h, scenario.fcKgH[h] ?? 0)]);
  return { assets, rows: [...tankRows, ...flowRows] };
}

/** 9~15시 9 kg/h 생산, 17~21시 9 kg/h 소비 */
export const HEALTHY_H2: H2DayScenario = {
  producedKgH: hoursOf(0, 24).map((h) => (h >= 9 && h < 16 ? 9 : 0)),
  fcKgH: hoursOf(0, 24).map((h) => (h >= 17 && h < 22 ? 9 : 0)),
  leakKg: 0,
  startMassKg: 110,
};

// ── 태양광 ──────────────────────────────────────────────────────────────

export const WX_ID = 20;
export const INVERTER_IDS = [21, 22, 23, 24] as const;
export const RACK_IDS = [30, 31] as const;
export const INVERTER_KWP = 300;
export const INVERTER_AC_KW = 250;

export const PV_ASSETS: readonly LedgerAsset[] = [
  asset(WX_ID, 'WX1', 'wx.station', { poa_tilt_deg: 30 }),
  ...INVERTER_IDS.map((id, i) => asset(id, `PV1/INV0${i + 1}`, 'pv.inverter', { dc_kwp: INVERTER_KWP, ac_kw: INVERTER_AC_KW })),
  ...RACK_IDS.map((id, i) => asset(id, `ESS1/RACK0${i + 1}`, 'ess.rack', { energy_kwh: 500 })),
];

/** 맑은 날 경사면 일사 [W/m²] (6~18시) */
export const CLEAR_POA: Readonly<Record<number, number>> = { 6: 100, 7: 300, 8: 500, 9: 700, 10: 850, 11: 950, 12: 1000, 13: 1150, 14: 1000, 15: 800, 16: 600, 17: 350, 18: 120 };

export interface InverterHourOverride {
  readonly actual?: number;
  readonly max?: number;
  readonly limit?: number;
  readonly stateFirst?: number;
  readonly stateLast?: number;
  readonly stateMax?: number;
  readonly heatsink?: number;
  /** true면 이 시간 ac.power 행을 만들지 않는다 */
  readonly noPower?: boolean;
}

export interface PvDaySpec {
  /** DAY 기준 날짜 번호 */
  readonly day?: number;
  readonly poa: Readonly<Record<number, number>>;
  /** 실제 발전 = 이 PR로 만든 기대값 (override.actual이 없을 때) */
  readonly pr: number;
  /** 모듈 온도 [°C]. null이면 행을 만들지 않는다 */
  readonly moduleTempC?: number | null;
  readonly gammaPerC?: number;
  readonly actual?: (inverterId: number, hour: number, expected: number) => number;
  readonly override?: (inverterId: number, hour: number) => InverterHourOverride | undefined;
  /** 시간 → 랙별 SOC 시간 최대 [%] */
  readonly soc?: Readonly<Record<number, readonly number[]>>;
}

/** 인버터 한 시간 기대 발전 [kWh] = POA/1000 × kWp × PR × (1 + γ(T − 25)) */
export const pvExpected = (poa: number, pr: number, moduleTempC: number | null = 25, gammaPerC = -0.0035): number =>
  (poa / 1000) * INVERTER_KWP * pr * (moduleTempC === null ? 1 : 1 + gammaPerC * (moduleTempC - 25));

export function pvRows(spec: PvDaySpec): LedgerHourRow[] {
  const offset = 24 * (spec.day ?? 0);
  const tempC = spec.moduleTempC === undefined ? 25 : spec.moduleTempC;
  return Object.entries(spec.poa).flatMap(([hourText, poa]) => {
    const hour = Number(hourText);
    const at = hour + offset;
    const weather = [row(WX_ID, 'poa.irradiance', at, poa, { periodS: 300, n: 12, nGood: 12 }), ...(tempC === null ? [] : [row(WX_ID, 'module.temp', at, tempC, { periodS: 300, n: 12, nGood: 12 })])];
    const racks = (spec.soc?.[hour] ?? []).map((soc, i) => row(RACK_IDS[i] ?? 0, 'batt.soc', at, soc - 1, { max: soc }));
    const inverters = INVERTER_IDS.flatMap((id) => {
      const o = spec.override?.(id, hour) ?? {};
      const expected = pvExpected(poa, spec.pr, tempC, spec.gammaPerC);
      const actual = o.actual ?? spec.actual?.(id, hour, expected) ?? expected;
      const first = o.stateFirst ?? 3;
      const last = o.stateLast ?? 3;
      return [
        ...(o.noPower ? [] : [row(id, 'ac.power', at, actual, { max: o.max ?? actual })]),
        row(id, 'ac.power.limit', at, o.limit ?? 100, { min: o.limit ?? 100, periodS: 300, n: 12, nGood: 12 }),
        row(id, 'op.state', at, last, { first, last, max: o.stateMax ?? Math.max(first, last), periodS: 300, n: 12, nGood: 12 }),
        row(id, 'heatsink.temp', at, o.heatsink ?? 50, { periodS: 300, n: 12, nGood: 12 }),
      ];
    });
    return [...weather, ...racks, ...inverters];
  });
}
