import { describe, expect, it } from 'vitest';
import { ALLOC_VERSION, type EnergyFlow, type H2Ledger, type PvLossBreakdown, type SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { ledgerDqSummary } from './dq';
import { parseLedgerRow } from './parse';
import { chainPeriodSearch, parseDay, resolveChainPeriod } from './period';
import { energySankey, hydrogenSankey } from './sankey';
import { pvLossView, residualPoints, shareView } from './series';

const H2: H2Ledger = {
  produced: 50,
  delivered: 0,
  fc_consumed: 40,
  stored_delta: 8,
  vented_est: 0,
  residual: 2,
  residual_pct: 4,
  method: { produced: 'meter_total', delivered: null, fc_consumed: 'meter', stored_delta: 'lemmon2008@1', vented: 'not_estimated' },
  aux: { faraday_expected: null, purge_count: null, tank_temp_delta_c: null },
};

const PV_LOSS: PvLossBreakdown = { expected: 1000, actual: 900, outage: 0, ess_full: 10, curtailment: 50, clipping: 20, derating: 0, soiling_est: 0, unexplained: 20 };

function day(dayString: string, extra: Partial<SiteEnergyDay> = {}): SiteEnergyDay {
  const flows: EnergyFlow[] = [
    { from: 'pv', to: 'electrolyzer', kwh: 600 },
    { from: 'pv', to: 'grid_export', kwh: 300 },
    { from: 'grid_import', to: 'electrolyzer', kwh: 100 },
    { from: 'unmetered', to: 'site_aux', kwh: 0.0001 },
    { from: 'fc', to: 'compressor', kwh: 0 },
    { from: 'pv', to: 'unmetered', kwh: 10 },
  ];
  return {
    day: dayString,
    flows_kwh: flows,
    energy_kwh: { pv: 910, ess_discharge: 0, fc: 0, grid_import: 100, site_aux: 0.0001, ess_charge: 0, electrolyzer: 700, electrolyzer_system: 720, compressor: 0, grid_export: 300, unmetered_supply: 0.0001, unmetered_demand: 10 },
    h2_kg: H2,
    elz_grid_share: 100 / 700,
    renewable_share: 600 / 700,
    elz_sec_kwh_per_kg: 14.4,
    fc_kg_per_mwh: null,
    p2p_efficiency: null,
    pv_loss_kwh: PV_LOSS,
    dq: {
      energy: { completeness: { 'pv.inverter/ac.power': 1, 'grid.meter/ac.power': 1 }, aux_basis: 'residual', aux_residual_kwh: 0, unmetered_kwh: 10.0001, unmetered_ratio: 0.0099, elz_flow_basis: 'rectifier_input', elz_energy_basis: 'system_total' },
      h2: { completeness: 1, purge_count_missing: false, delivered_missing: false },
      pv: { completeness: 1, pr_ref: 0.9, pr_ref_method: 'reference_clear_days', soiling_status: 'not_estimated', temp_corrected_ratio: 1, no_data_inverter_hours: 0, reason: null },
    },
    alloc_version: ALLOC_VERSION,
    calc_version: 'ledger@2',
    ...extra,
  };
}

describe('energySankey', () => {
  it('기간 흐름을 (공급, 수요)별로 더하고, 0 흐름·링크 없는 노드를 빼며 미계측은 양쪽 id를 나눈다', () => {
    const data = energySankey([day('2026-09-01'), day('2026-09-02')]);
    expect(data.links).toEqual([
      { source: 'supply:pv', target: 'demand:electrolyzer', value: 1200, unmetered: false },
      { source: 'supply:pv', target: 'demand:grid_export', value: 600, unmetered: false },
      { source: 'supply:pv', target: 'demand:unmetered', value: 20, unmetered: true },
      { source: 'supply:grid_import', target: 'demand:electrolyzer', value: 200, unmetered: false },
    ]);
    // 미계측 공급 0.0001 × 2일 = 0.0002 kWh → 0.001 반올림 0 → 링크·노드 제거, 연료전지 → 압축기 0 흐름도 제거
    expect(data.nodes.some((n) => n.id === 'supply:unmetered' || n.id === 'supply:fc')).toBe(false);
    expect(data.nodes.map((n) => [n.id, n.label, n.side, n.value, n.unmetered])).toEqual([
      ['supply:pv', '태양광', 'supply', 1820, false],
      ['supply:grid_import', '계통 수전', 'supply', 200, false],
      ['demand:electrolyzer', '전해조', 'demand', 1400, false],
      ['demand:grid_export', '계통 송전', 'demand', 600, false],
      ['demand:unmetered', '미계측 수요', 'demand', 20, true],
    ]);
    expect(data).toMatchObject({ total: 2020, days: 2 });
    expect(energySankey([])).toEqual({ nodes: [], links: [], total: 0, days: 0 });
  });
});

describe('hydrogenSankey', () => {
  it('생산 → 연료전지·저장 증가·잔차 손실, 공급·수요 합이 같고 잔차는 성분으로 다시 계산한다', () => {
    const data = hydrogenSankey([day('2026-09-01'), day('2026-09-02', { h2_kg: { ...H2, residual: null } })]);
    expect(data.days).toBe(1);
    expect(data.nodes.map((n) => [n.label, n.value])).toEqual([
      ['전해조 생산', 50],
      ['연료전지 소비', 40],
      ['저장 증가', 8],
      ['잔차(설명 안 된 손실)', 2],
    ]);
    expect(data.links.find((l) => l.target === 'h2:residualOut')).toMatchObject({ source: 'h2:produced', value: 2, unmetered: true });
  });

  it('저장 인출·음의 잔차는 공급 쪽 노드가 되고 비례 할당한다', () => {
    const data = hydrogenSankey([day('2026-09-01', { h2_kg: { ...H2, produced: 20, fc_consumed: 40, stored_delta: -21, residual: 1 } })]);
    // P 20 + 인출 21 = 소비 40 + 잔차 손실 1 (합 41)
    expect(data.nodes.filter((n) => n.side === 'supply').map((n) => [n.label, n.value])).toEqual([
      ['전해조 생산', 20],
      ['저장 인출', 21],
    ]);
    expect(data.links.find((l) => l.source === 'h2:storageOut' && l.target === 'h2:fcConsumed')?.value).toBeCloseTo((21 * 40) / 41, 3);
    const gain = hydrogenSankey([day('2026-09-01', { h2_kg: { ...H2, produced: 50, fc_consumed: 45, stored_delta: 8, residual: -3 } })]);
    expect(gain.nodes.find((n) => n.id === 'h2:residualIn')).toMatchObject({ value: 3, side: 'supply', unmetered: true });
    expect(hydrogenSankey([day('2026-09-01', { h2_kg: { ...H2, produced: null } })]).nodes).toEqual([]);
  });
});

describe('pvLossView', () => {
  it('날짜별 누적 막대 값(표시 순서), 분해 없는 날은 null·사유 집계, 기간 합과 기대 대비 %', () => {
    const noPr = day('2026-09-02', { pv_loss_kwh: null, dq: { ...day('x').dq, pv: { ...day('x').dq.pv, reason: 'pr_ref_missing' } } });
    const view = pvLossView([day('2026-09-01'), noPr, day('2026-09-03', { pv_loss_kwh: { ...PV_LOSS, unexplained: -15, curtailment: 85 } })]);
    expect(view.days).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(view.series.map((s) => s.label)).toEqual(['출력제어', '클리핑', '정지', '열 저감', 'ESS 만충', '오염 추정', '설명 안 됨']);
    expect(view.series[0]?.values).toEqual([50, null, 85]);
    expect(view.series[6]?.values).toEqual([20, null, -15]);
    expect(view.totals.find((t) => t.bucket === 'curtailment')).toEqual({ bucket: 'curtailment', label: '출력제어', kwh: 135, pctOfExpected: 6.75 });
    expect(view).toMatchObject({ expectedKwh: 2000, actualKwh: 1800, daysWithBreakdown: 2, missingReasons: { pr_ref_missing: 1 } });
    expect(pvLossView([noPr]).totals[0]?.pctOfExpected).toBeNull();
  });
});

describe('잔차·비율·품질 경고', () => {
  it('잔차 점은 잔차가 있는 날만, 완결성 기준 미만은 low', () => {
    const points = residualPoints([day('2026-09-01'), day('2026-09-02', { h2_kg: { ...H2, residual: null } }), day('2026-09-03', { dq: { ...day('x').dq, h2: { completeness: 0.5, purge_count_missing: false, delivered_missing: false } } })], 0.9);
    expect(points).toEqual([
      { day: '2026-09-01', residualKg: 2, residualPct: 4, completeness: 1, low: false },
      { day: '2026-09-03', residualKg: 2, residualPct: 4, completeness: 0.5, low: true },
    ]);
  });

  it('전해조 전력 기간 비율은 kWh 가중, 전해조 전력이 없으면 null', () => {
    const view = shareView([day('2026-09-01'), day('2026-09-02', { elz_grid_share: null, renewable_share: null })]);
    expect(view).toMatchObject({ gridShare: 0.1429, renewableShare: 0.8571, electrolyzerKwh: 700 });
    expect(view.points).toHaveLength(1);
    expect(shareView([]).gridShare).toBeNull();
  });

  it('완결성 부족일·불일치율 경고', () => {
    const base = day('x').dq;
    const bad = day('2026-09-02', { dq: { ...base, energy: { ...base.energy, completeness: { 'pv.inverter/ac.power': 0.5, 'grid.meter/ac.power': null }, unmetered_kwh: 400, unmetered_ratio: 0.2 } } });
    const summary = ledgerDqSummary([day('2026-09-01'), bad]);
    expect(summary.warnings.map((w) => w.code)).toEqual(['energy_completeness', 'unmetered_period', 'unmetered_days']);
    expect(summary.warnings[0]).toMatchObject({ sampleDays: ['2026-09-02'], message: expect.stringContaining('pv.inverter/ac.power') });
    expect(summary.periodUnmeteredRatio).toBeCloseTo(410.0001 / 2020.0002, 6);
    expect(ledgerDqSummary([day('2026-09-01')]).warnings).toEqual([]);
  });
});

describe('기간·행 읽기', () => {
  const NOW = Date.parse('2026-09-15T07:30:00Z'); // KST 16:30

  it('프리셋 끝은 KST 어제, 사용자 지정은 양 끝 포함·어제로 자르고 틀리면 30일', () => {
    expect(resolveChainPeriod({ chain: '7' }, NOW)).toEqual({ kind: 'preset', presetDays: 7, fromDay: '2026-09-08', toDay: '2026-09-14', days: 7, label: '최근 7일' });
    expect(resolveChainPeriod({ chain: 'custom', from: '2026-08-01', to: '2026-09-30' }, NOW)).toMatchObject({ kind: 'custom', fromDay: '2026-08-01', toDay: '2026-09-14', days: 45 });
    expect(resolveChainPeriod({ chain: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW)).toMatchObject({ kind: 'preset', presetDays: 30 });
    expect(resolveChainPeriod({ chain: 'custom', from: '2025-01-01', to: '2026-09-01' }, NOW).presetDays).toBe(30);
    expect(resolveChainPeriod({ chain: '14' }, NOW).presetDays).toBe(30);
    expect(chainPeriodSearch(resolveChainPeriod({ chain: 'custom', from: '2026-09-01', to: '2026-09-10' }, NOW))).toBe('chain=custom&from=2026-09-01&to=2026-09-10');
    expect(chainPeriodSearch(resolveChainPeriod({ chain: '90' }, NOW))).toBe('chain=90');
    expect(parseDay('2026-13-01')).toBeNull();
  });

  it('jsonb 행: 모르는 노드 흐름은 버리고 빠진 값은 0·null', () => {
    const parsed = parseLedgerRow({
      day: '2026-09-01',
      flows_kwh: [{ from: 'pv', to: 'electrolyzer', kwh: 5 }, { from: 'moon', to: 'electrolyzer', kwh: 1 }, 'x'],
      energy_kwh: { pv: 5 },
      h2_kg: { produced: 1, method: { produced: 'meter' } },
      elz_grid_share: null,
      renewable_share: null,
      elz_sec_kwh_per_kg: null,
      fc_kg_per_mwh: null,
      p2p_efficiency: null,
      pv_loss_kwh: null,
      dq: {},
      calc_version: 'ledger@2',
    });
    expect(parsed.flows_kwh).toEqual([{ from: 'pv', to: 'electrolyzer', kwh: 5 }]);
    expect(parsed.energy_kwh).toMatchObject({ pv: 5, fc: 0 });
    expect(parsed.h2_kg).toMatchObject({ produced: 1, fc_consumed: null, method: { produced: 'meter', vented: 'not_estimated' } });
    expect(parsed.dq.energy).toMatchObject({ completeness: {}, unmetered_ratio: null, aux_basis: 'residual' });
    expect(parsed.pv_loss_kwh).toBeNull();
  });
});
