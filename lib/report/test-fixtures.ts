// 리포트 unit 테스트 입력: 탐지기 6종 스냅샷 형식(lib/analytics/detectors의 evidence)을 따른 발견사항 + KPI·검증·시장가격 행.
import type { FindingInput, PackInput } from './evidence-pack';
import { resolveReportPeriod } from './period';

const DAY = 86_400_000;
export const KST_2026_09_01 = Date.UTC(2026, 7, 31, 15);
export const GENERATED_AT = Date.UTC(2026, 8, 15, 3);

const period = resolveReportPeriod({ kind: 'month', month: '2026-09' });
if (!period.ok) throw new Error('fixture period');
export const SEPTEMBER = period.period;

export const capacitySnapshot = (points = 70) => ({
  method: 'matched_ratio',
  metric: 'capacity_ah_soc',
  reference: { n: 20, from: KST_2026_09_01 - 100 * DAY, to: KST_2026_09_01 - 70 * DAY },
  recent: { n: 12, from: KST_2026_09_01 - 7 * DAY, to: KST_2026_09_01 + 13 * DAY },
  bins: [
    { key: '0.1|20', n_ref: 12, n_cur: 7, med_ref: 586.5, med_cur: 543.1, ratio: 0.926, used: true },
    { key: '0.15|20', n_ref: 8, n_cur: 5, med_ref: 587.1, med_cur: 544.0, ratio: 0.9266, used: true },
    { key: '0.25|30', n_ref: 2, n_cur: 1, med_ref: 590, med_cur: 550, ratio: 0.93, used: false },
  ],
  bin_widths: { c_rate: 0.05, temp_c: 5 },
  trend: {
    slope_pct_per_month: -2.5,
    ci_low_pct_per_month: -2.72,
    ci_high_pct_per_month: -2.29,
    points: Array.from({ length: points }, (_, i) => ({ t: KST_2026_09_01 - 100 * DAY + i * DAY, soh_pct: 97.7 - i * 0.08 })),
    line: [
      { t: KST_2026_09_01 - 100 * DAY, soh_pct: 99.1 },
      { t: KST_2026_09_01 + 13 * DAY, soh_pct: 89.4 },
    ],
    soh_target_pct: 80,
    soh_target_date: { estimate: Date.UTC(2027, 3, 30, 15), early: null, late: null },
  },
  charge_time: { reference_current_a: 58.65, baseline_hours: 10, current_hours: 9.26 },
  checks: [
    { id: 'cold', label: '저온 운전 영향', status: 'refutes', measured: { shift_c: 0.4 }, note: '' },
    { id: 'cell_imbalance', label: '셀 불균형으로 인한 조기 종료', status: 'supports', measured: {}, note: '' },
  ],
});

const stackSnapshot = {
  method: 'binned_residual_theil_sen',
  break_in_hours: 1000,
  excluded_break_in: 12,
  bins: [
    { key: '1.0|60', n: 150, median_v_mv: 1910.2, op_h_min: 1010, op_h_max: 1950 },
    { key: '1.2|60', n: 90, median_v_mv: 1932.4, op_h_min: 1020, op_h_max: 1948 },
  ],
  trend: {
    slope_uv_per_h: 21.432,
    ci_low_uv_per_h: 20.677,
    ci_high_uv_per_h: 22.204,
    points: [
      { op_h: 1020, dv_mv: -8 },
      { op_h: 1500, dv_mv: 1.2 },
      { op_h: 1950, dv_mv: 12 },
    ],
    line: [
      { op_h: 1020, dv_mv: -9.8 },
      { op_h: 1950, dv_mv: 10.1 },
    ],
  },
  checks: [{ id: 'temperature', label: '스택 온도 저하', status: 'refutes', measured: {}, note: '' }],
};

const cellSnapshot = {
  method: 'median_shift_trend_peer',
  source: 'charge_end',
  reference: { n: 15, median_mv: 8 },
  recent: { n: 20, median_mv: 31.7 },
  trend: { slope_mv_per_month: 10.1, ci_low_mv_per_month: 9.4, ci_high_mv_per_month: 10.9, points: [{ t: KST_2026_09_01 - 60 * DAY, dv_mv: 12 }, { t: KST_2026_09_01 + 13 * DAY, dv_mv: 31 }], line: null },
  peers: { n: 3, modified_z: 5.2, values_mv: [{ asset_id: 11, dv_mv: 8.2 }, { asset_id: 13, dv_mv: 7.9 }, { asset_id: 14, dv_mv: 8.4 }] },
};

const pvSnapshot = {
  method: 'peer_modified_z',
  days: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'].map((day) => ({ day, kwh_per_kwp: 4.09, peer_median: 4.18, deviation_pct: -2.05, modified_z: -4.1, peers: 4, flagged: true })),
  excluded_days: 1,
};

const dqSnapshot = {
  method: 'gap_flatline_summary',
  points: [
    { point_id: 1, source_key: 'PV1/INV02/P_AC', metric_key: 'ac.power', completeness: 0.912, gap_hours: 6, gaps: [], longest_flatline_hours: 0, flatlines: [] },
    { point_id: 2, source_key: 'PV1/INV02/T', metric_key: 'temp', completeness: 1, gap_hours: 0, gaps: [], longest_flatline_hours: 12.5, flatlines: [] },
  ],
  gap_points: 1,
  flatline_points: 1,
};

const base = (id: string, overrides: Partial<FindingInput>): FindingInput => ({
  id,
  assetId: Number(id) * 10,
  assetPath: 'SIM-A/ESS1/RACK01',
  assetCriticality: 4,
  detectorId: 'ess.capacity_fade',
  detectorVersion: '1',
  failureMode: 'ess.capacity_fade',
  category: 'degradation',
  title: '배터리 유효용량 7.4% 감소',
  severity: 3,
  confidence: 0.85,
  status: 'new',
  effect: { metric: 'capacity_ah_soc', value: -7.396, unit: '%', ciLow: -7.467, ciHigh: -7.218, baseline: 586.52, current: 543.14, levelUnit: 'Ah' },
  windowStart: KST_2026_09_01 - 100 * DAY,
  windowEnd: KST_2026_09_01 + 13 * DAY,
  firstDetectedAt: KST_2026_09_01 + 10 * DAY,
  lastDetectedAt: KST_2026_09_01 + 13 * DAY,
  detectionCount: 3,
  previousFindingId: null,
  evidenceId: `${Number(id) * 100}`,
  evidenceComputedAt: KST_2026_09_01 + 13 * DAY,
  snapshot: capacitySnapshot(),
  transitions: [{ from: null, to: 'new', at: KST_2026_09_01 + 10 * DAY, actor: 'system' }],
  actions: [],
  ...overrides,
});

export const capacityFinding = (overrides: Partial<FindingInput> = {}): FindingInput => base('1', overrides);

export const stackFinding = (overrides: Partial<FindingInput> = {}): FindingInput =>
  base('4', {
    assetPath: 'SIM-B/ELZ1/STACK1',
    assetCriticality: 5,
    detectorId: 'el.voltage_rise',
    failureMode: 'el.stack_voltage_degradation',
    title: '스택 셀 평균 전압 상승 21.4 µV/h',
    severity: 4,
    confidence: 0.99,
    effect: { metric: 'v_cell_rise_rate', value: 21.432, unit: 'µV/h', ciLow: 20.677, ciHigh: 22.204, baseline: 1907.55, current: 1923.8, levelUnit: 'mV' },
    snapshot: stackSnapshot,
    ...overrides,
  });

export const cellFinding = (overrides: Partial<FindingInput> = {}): FindingInput =>
  base('2', {
    assetPath: 'SIM-A/ESS1/RACK03',
    detectorId: 'ess.cell_imbalance',
    failureMode: 'ess.cell_imbalance',
    title: '셀 전압 편차 24 mV 증가',
    confidence: 0.98,
    effect: { metric: 'cell_dv_mv', value: 23.7, unit: 'mV', ciLow: 22.75, ciHigh: 25.6, baseline: 8, current: 31.7, levelUnit: 'mV' },
    snapshot: cellSnapshot,
    ...overrides,
  });

export const pvFinding = (overrides: Partial<FindingInput> = {}): FindingInput =>
  base('3', {
    assetPath: 'SIM-A/PV1/INV01',
    assetCriticality: 3,
    detectorId: 'pv.inverter_peer',
    failureMode: 'pv.inverter_underperformance',
    category: 'performance',
    title: '인버터 발전량 동종 대비 2.1% 낮음',
    severity: 2,
    confidence: 0.73,
    detectionCount: 1,
    effect: { metric: 'kwh_per_kwp_vs_peer', value: -2.052, unit: '%', ciLow: -2.072, ciHigh: -2.042, baseline: 4.1798, current: 4.0935, levelUnit: 'kWh/kWp' },
    windowStart: KST_2026_09_01 + 6 * DAY,
    windowEnd: KST_2026_09_01 + 13 * DAY,
    snapshot: pvSnapshot,
    ...overrides,
  });

export const dqFinding = (overrides: Partial<FindingInput> = {}): FindingInput =>
  base('7', {
    assetPath: 'SIM-A/PV1/INV02',
    assetCriticality: 3,
    detectorId: 'dq.gap_flatline',
    failureMode: 'dq.data_gap_flatline',
    category: 'data_quality',
    title: '데이터 품질: 수신 결측·센서 값 고착',
    severity: 2,
    confidence: 0.9,
    effect: { metric: 'dq.completeness', value: 95.6, unit: '%', ciLow: null, ciHigh: null, baseline: 100, current: 95.6, levelUnit: '%' },
    snapshot: dqSnapshot,
    ...overrides,
  });

export function packInput(overrides: Partial<PackInput> = {}): PackInput {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
  return {
    site: { id: 1, code: 'SIM-A', name: '영암 태양광·ESS' },
    period: SEPTEMBER,
    selection: { findingIds: ['1', '2', '3', '4', '7'], includeVerifiedActions: true, basedOnReportId: null },
    generatedAt: GENERATED_AT,
    findings: [capacityFinding(), cellFinding(), pvFinding(), stackFinding(), dqFinding()],
    kpiRows: [
      ...days.map((day, i) => ({ scopeType: 'site' as const, assetPath: null, day, key: 'pv.kwh', value: 4000 + i * 10, dqCompleteness: 0.99 })),
      ...days.flatMap((day) => [
        { scopeType: 'asset' as const, assetPath: 'SIM-A/ESS1/RACK01', day, key: 'ess.rte', value: 0.912, dqCompleteness: 1 },
        { scopeType: 'asset' as const, assetPath: 'SIM-A/ESS1/RACK02', day, key: 'ess.rte', value: 0.9, dqCompleteness: 1 },
        { scopeType: 'asset' as const, assetPath: 'SIM-A/PV1/INV02', day, key: 'pv.kwh', value: 950, dqCompleteness: 0.9 },
      ]),
    ],
    energy: { pvKwh: 12030.44, essChargeKwh: 3000, essDischargeKwh: 2700.2, h2Kg: null, fcKwh: null },
    verifications: [
      {
        id: '9',
        actionId: '5',
        findingId: '2',
        assetPath: 'SIM-A/ESS1/RACK03',
        actionType: '완충 유지로 밸런싱 시간 확보',
        performedAt: KST_2026_09_01 - 40 * DAY,
        verdict: 'improved',
        effect: -6.2,
        ciLow: -7.1,
        ciHigh: -5.3,
        beforeStats: { metric: 'ess.cell_dv_mv', unit: 'mV', n: 12, bins: [] },
        afterStats: { n: 11, bins: [] },
        computedAt: KST_2026_09_01 + 13 * DAY,
      },
    ],
    market: [
      { day: '2026-09-01', key: 'smp_land', value: 140.1, unit: '원/kWh' },
      { day: '2026-09-02', key: 'smp_land', value: 144.5, unit: '원/kWh' },
    ],
    ...overrides,
  };
}
