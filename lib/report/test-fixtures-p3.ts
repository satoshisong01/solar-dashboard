// 리포트 unit 테스트 입력 (P3): demo 분석이 저장한 P3 발견사항 8종(lib/desk/p3-evidence-fixtures 스냅샷)과 체인 원장 일 행.
import { ALLOC_VERSION, type SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { BLOWER_SNAPSHOT, COMP_SEC_RISE_SNAPSHOT, EL_SEC_RISE_SNAPSHOT, MASS_BALANCE_SNAPSHOT_V1, RESISTANCE_SNAPSHOT, SOILING_SNAPSHOT_V1, TANK_LEAK_SNAPSHOT, THERMAL_SNAPSHOT } from '@/lib/desk/p3-evidence-fixtures';
import type { FindingInput } from './evidence-pack';
import { capacityFinding, KST_2026_09_01 } from './test-fixtures';

const DAY = 86_400_000;

type Effect = readonly [metric: string, value: number, ciLow: number, ciHigh: number, baseline: number, current: number, levelUnit: string, unit?: string];

const p3 = (id: string, detectorId: string, failureMode: string, effect: Effect, overrides: Partial<FindingInput>): FindingInput =>
  capacityFinding({
    id,
    assetId: Number(id) * 10,
    detectorId,
    failureMode,
    effect: { metric: effect[0], value: effect[1], unit: effect[7] ?? '%', ciLow: effect[2], ciHigh: effect[3], baseline: effect[4], current: effect[5], levelUnit: effect[6] },
    windowStart: KST_2026_09_01 - 100 * DAY,
    windowEnd: KST_2026_09_01 + 13 * DAY,
    detectionCount: 2,
    ...overrides,
  });

export const tankFinding = (o: Partial<FindingInput> = {}) =>
  p3('10', 'tank.static_leak', 'h2.storage_leak', ['tank_leak_kg_per_day', 1.0328, 0.9481, 1.1175, -0.0046, 1.0328, 'kg/일', 'kg/일'], { assetPath: 'SIM-B/H2BANK1/TANK3', category: 'safety', severity: 4, confidence: 0.7, detectionCount: 3, title: '저장용기 누설 의심 1.03 kg/일 — 즉시 현장 확인', snapshot: TANK_LEAK_SNAPSHOT, ...o });

export const massBalanceFinding = (o: Partial<FindingInput> = {}) =>
  p3('13', 'h2chain.mass_balance_gap', 'h2chain.mass_balance_gap', ['h2_residual_pct', 2.284, 2.265, 2.345, 0.022, 2.284, '%'], { assetId: null, assetPath: null, category: 'performance', severity: 3, confidence: 0.71, detectionCount: 3, title: '수소 물질수지 잔차 +2.3%', snapshot: MASS_BALANCE_SNAPSHOT_V1, ...o });

export const elSecFinding = (o: Partial<FindingInput> = {}) =>
  p3('9', 'el.sec_rise', 'el.system_efficiency_loss', ['sec_kwh_per_kg', 5.526, 5.114, 5.987, 58.168, 61.383, 'kWh/kg'], { assetPath: 'SIM-B/ELZ1/STACK1', category: 'performance', severity: 3, confidence: 0.97, title: '전해조 시스템 비에너지 5.5% 상승', snapshot: EL_SEC_RISE_SNAPSHOT, ...o });

export const compFinding = (o: Partial<FindingInput> = {}) =>
  p3('11', 'comp.sec_rise', 'comp.efficiency_loss', ['comp_sec_kwh_per_kg', 7.966, 6.408, 9.471, 1.9734, 2.1306, 'kWh/kg'], { assetPath: 'SIM-B/COMP1', category: 'performance', severity: 2, confidence: 0.92, title: '압축기 비에너지 8.0% 상승', snapshot: COMP_SEC_RISE_SNAPSHOT, ...o });

export const blowerFinding = (o: Partial<FindingInput> = {}) =>
  p3('12', 'fc.blower_wear', 'fc.blower_wear', ['blower_specific_power', 12.128, 7.224, 20.992, 9.7743, 10.9598, 'W/(kg/h)'], { assetPath: 'SIM-B/FC1/BLOWER1', category: 'degradation', severity: 2, confidence: 0.72, title: '공기 블로워 비전력 12.1% 증가', snapshot: BLOWER_SNAPSHOT, ...o });

export const resistanceFinding = (o: Partial<FindingInput> = {}) =>
  p3('5', 'ess.resistance_growth', 'ess.resistance_growth', ['R_60s', 37.752, 11.15, 73.104, 34.1, 46.98, 'mΩ'], { assetPath: 'SIM-A/ESS1/RACK02', category: 'degradation', severity: 2, confidence: 0.71, title: '랙 직류 내부저항(R_60s) 37.8% 증가', snapshot: RESISTANCE_SNAPSHOT, ...o });

export const soilingFinding = (o: Partial<FindingInput> = {}) =>
  p3('4', 'pv.soiling_rate', 'pv.soiling', ['soiling_loss_pct', 3.725, 0.809, 5.559, 0.9351, 0.9003, 'PI'], { assetId: null, assetPath: null, category: 'performance', severity: 2, confidence: 0.47, title: '태양광 오염 손실 약 3.7% (오염 속도 0.05%/일)', windowStart: KST_2026_09_01 - 57 * DAY, snapshot: SOILING_SNAPSHOT_V1, ...o });

export const thermalFinding = (o: Partial<FindingInput> = {}) =>
  p3('6', 'inv.thermal_derating', 'pv.inverter_thermal_derating', ['thermal_derate_loss_pct', 0.524, 0.192, 0.865, 1, 0.524, '%'], { assetPath: 'SIM-A/PV1/INV02', category: 'performance', severity: 2, confidence: 0.77, title: '인버터 열 출력저감 손실 0.5% (최근 30일 저감 6.8시간)', snapshot: THERMAL_SNAPSHOT, ...o });

export const P3_FINDINGS = (): FindingInput[] => [tankFinding(), massBalanceFinding(), elSecFinding(), compFinding(), blowerFinding(), resistanceFinding(), soilingFinding(), thermalFinding()];

/** 체인 원장 하루: 태양광·계통 → 전해조·압축기·계통 송전, 수소 생산 − 연료전지 − 저장 증감 − 배기 = 잔차 */
export function ledgerDay(day: string, extra: Partial<SiteEnergyDay> = {}): SiteEnergyDay {
  return {
    day,
    flows_kwh: [
      { from: 'pv', to: 'electrolyzer', kwh: 2400 },
      { from: 'grid_import', to: 'electrolyzer', kwh: 100 },
      { from: 'pv', to: 'compressor', kwh: 90 },
      { from: 'pv', to: 'grid_export', kwh: 1500 },
      { from: 'fc', to: 'site_aux', kwh: 60 },
    ],
    energy_kwh: { pv: 3990, ess_discharge: 0, fc: 60, grid_import: 100, site_aux: 60, ess_charge: 0, electrolyzer: 2500, electrolyzer_system: 2600, compressor: 90, grid_export: 1500, unmetered_supply: 0, unmetered_demand: 0 },
    h2_kg: { produced: 45, fc_consumed: 4, stored_delta: 39.5, vented_est: 0.5, residual: 1, residual_pct: 2.22, method: { produced: 'meter_total', fc_consumed: 'meter', stored_delta: 'lemmon2008@1', vented: 'params' }, aux: { faraday_expected: 46, purge_count: 20, tank_temp_delta_c: 1 } },
    elz_grid_share: 0.04,
    renewable_share: 0.96,
    elz_sec_kwh_per_kg: 57.8,
    fc_kg_per_mwh: 66.7,
    p2p_efficiency: 0.25,
    pv_loss_kwh: { expected: 4300, actual: 3990, outage: 0, ess_full: 0, curtailment: 120, clipping: 40, derating: 10, soiling_est: 100, unexplained: 40 },
    dq: {
      energy: { completeness: { 'pv.inverter/ac.power': 1 }, aux_basis: 'residual', aux_residual_kwh: 0, unmetered_kwh: 5, unmetered_ratio: 0.0012, elz_flow_basis: 'rectifier_input', elz_energy_basis: 'system_total' },
      h2: { completeness: 1, purge_count_missing: false },
      pv: { completeness: 1, pr_ref: 0.93, pr_ref_method: 'reference_clear_days', soiling_status: 'estimated', temp_corrected_ratio: 1, no_data_inverter_hours: 0, reason: null },
    },
    alloc_version: ALLOC_VERSION,
    calc_version: 'ledger@2',
    ...extra,
  };
}
