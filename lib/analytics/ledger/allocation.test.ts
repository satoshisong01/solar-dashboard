import { describe, expect, it } from 'vitest';
import { allocateProportional, energyPool, hourPool } from './allocation';
import { createLedgerContext } from './hourly';
import { resolveLedgerParams, type LedgerParams } from './params';
import { asset, DAY, row } from './test-fixtures';
import { DEMAND_NODES, SUPPLY_NODES, UNMETERED, type DemandNode, type EnergyFlow, type LedgerHourRow, type SupplyNode } from './types';

const zeroSupply: Record<SupplyNode, number> = { pv: 0, ess_discharge: 0, fc: 0, grid_import: 0, unmetered: 0 };
const zeroDemand: Record<DemandNode, number> = { site_aux: 0, ess_charge: 0, electrolyzer: 0, compressor: 0, grid_export: 0, unmetered: 0 };

/** 연계형 사이트 설비: 인버터 2 · PCS · 계량기 · 정류기 · 전해조 · 압축기 · 연료전지 */
const ASSETS = [
  asset(1, 'PV1/INV01', 'pv.inverter'),
  asset(2, 'PV1/INV02', 'pv.inverter'),
  asset(3, 'ESS1/PCS1', 'ess.pcs'),
  asset(4, 'MTR1', 'grid.meter'),
  asset(5, 'ELZ1/RECT1', 'h2.elz.rectifier'),
  asset(6, 'ELZ1', 'h2.elz'),
  asset(7, 'COMP1', 'h2.compressor'),
  asset(8, 'FC1', 'fc.plant'),
];

interface HourSpec {
  readonly pv?: readonly [number, number];
  readonly pcs?: number;
  readonly grid?: number;
  readonly rect?: number;
  readonly elz?: number;
  readonly comp?: number;
  readonly fc?: number;
}

function hourRows(hour: number, s: HourSpec): LedgerHourRow[] {
  const entries: (readonly [number, string, number | undefined])[] = [
    [1, 'ac.power', s.pv?.[0]],
    [2, 'ac.power', s.pv?.[1]],
    [3, 'ac.power', s.pcs],
    [4, 'ac.power', s.grid],
    [5, 'ac.power', s.rect],
    [6, 'ac.power', s.elz],
    [7, 'compressor.power', s.comp],
    [8, 'fc.ac.power', s.fc],
  ];
  return entries.flatMap(([id, metric, value]) => (value === undefined ? [] : [row(id, metric, hour, value)]));
}

const poolOf = (rows: readonly LedgerHourRow[], params: Partial<LedgerParams> = {}) => {
  const p = resolveLedgerParams(params);
  return energyPool(createLedgerContext(DAY, ASSETS, rows, p.fallbackPeriodS), p);
};

const flowSum = (flows: readonly EnergyFlow[], pick: (f: EnergyFlow) => boolean): number => flows.filter(pick).reduce((sum, f) => sum + f.kwh, 0);

describe('allocateProportional (pool_hourly@1 비례 할당)', () => {
  it('손계산 예: PV 300 + 수전 100 → 보조 50 · 충전 150 · 전해조 200', () => {
    const flows = allocateProportional({ ...zeroSupply, pv: 300, grid_import: 100 }, { ...zeroDemand, site_aux: 50, ess_charge: 150, electrolyzer: 200 });
    expect(flows).toEqual([
      { from: 'pv', to: 'site_aux', kwh: 37.5 },
      { from: 'pv', to: 'ess_charge', kwh: 112.5 },
      { from: 'pv', to: 'electrolyzer', kwh: 150 },
      { from: 'grid_import', to: 'site_aux', kwh: 12.5 },
      { from: 'grid_import', to: 'ess_charge', kwh: 37.5 },
      { from: 'grid_import', to: 'electrolyzer', kwh: 50 },
    ]);
  });

  it('합이 다르면 호출 오류, 풀이 비면 빈 배열', () => {
    expect(() => allocateProportional({ ...zeroSupply, pv: 10 }, { ...zeroDemand, site_aux: 9 })).toThrow('공급 합');
    expect(allocateProportional(zeroSupply, zeroDemand)).toEqual([]);
  });
});

describe('energyPool', () => {
  // 보조부하 20 kW 추정. 각 시간 공급 합 = 계측 수요 합 (불일치 0)
  const balanced = [
    // 3시 대기: 인버터 야간 소비 1+1, 연료전지 대기 2, 전해조 BoP 1.5, 압축기 0.3, 보조 20 → 수전 25.8
    ...hourRows(3, { pv: [-1, -1], fc: -2, rect: 0, elz: 1.5, comp: 0.3, grid: -25.8 }),
    // 10시: PV 800 → 충전 200 · 정류기 450(BoP 20) · 압축기 30 · 보조 20 · 송전 80
    ...hourRows(10, { pv: [400, 400], pcs: -200, rect: 450, elz: 470, comp: 30, grid: 80 }),
    // 12시: PV 300 + 수전 220 → 정류기 450(BoP 20) · 압축기 30 · 보조 20
    ...hourRows(12, { pv: [150, 150], pcs: 0, rect: 450, elz: 470, comp: 30, grid: -220 }),
    // 20시: 방전 150 + 연료전지 150 → 인버터 야간 2 · 전해조 대기 6 · 압축기 0.3 · 보조 20 · 송전 271.7
    ...hourRows(20, { pv: [-1, -1], pcs: 150, fc: 150, rect: 0, elz: 6, comp: 0.3, grid: 271.7 }),
  ];

  it('에너지 보존: 공급원별 할당 합 = 공급, 수요처별 합 = 수요, 불일치 0', () => {
    const day = poolOf(balanced, { siteAuxKw: 20 });
    const supplyTotal = day.totals.pv + day.totals.ess_discharge + day.totals.fc + day.totals.grid_import;
    expect(flowSum(day.flows, () => true)).toBeCloseTo(supplyTotal, 2);
    for (const node of SUPPLY_NODES) expect(flowSum(day.flows, (f) => f.from === node)).toBeCloseTo(day.totals[node], 2);
    for (const node of DEMAND_NODES) expect(flowSum(day.flows, (f) => f.to === node)).toBeCloseTo(day.totals[node], 2);
    expect(day.totals).toMatchObject({ pv: 1100, ess_discharge: 150, fc: 150, grid_import: 245.8, ess_charge: 200, electrolyzer: 900, electrolyzer_system: 947.5, compressor: 60.6, grid_export: 351.7 });
    expect(day.totals.site_aux).toBeCloseTo(4 * 20 + 2 + 2 + 1.5 + 20 + 20 + 2 + 6, 6);
    expect(day.totals.unmetered_supply).toBe(0);
    expect(day.totals.unmetered_demand).toBe(0);
    expect(day.flows.some((f) => f.from === UNMETERED || f.to === UNMETERED)).toBe(false);
    expect(day.dq).toMatchObject({ aux_basis: 'estimate', aux_residual_kwh: 0, unmetered_kwh: 0, unmetered_ratio: 0, elz_flow_basis: 'rectifier_input', elz_energy_basis: 'system_total' });
  });

  it('전해조 계통 비율 = 전해조로 간 수전 / 전해조 kWh, 재생 비율 = (PV + ESS 방전) / 전해조 kWh', () => {
    const day = poolOf(balanced, { siteAuxKw: 20 });
    const gridToElz = (220 * 450) / 520;
    expect(day.elzGridShare).toBeCloseTo(gridToElz / 900, 4);
    expect(day.renewableShare).toBeCloseTo((450 + (300 * 450) / 520) / 900, 4);
    expect(flowSum(day.flows, (f) => f.from === 'grid_import' && f.to === 'electrolyzer')).toBeCloseTo(gridToElz, 3);
  });

  it('보조부하 추정이 있으면 남는 공급은 unmetered 수요, 모자라면 unmetered 공급으로 드러낸다', () => {
    const surplus = poolOf(hourRows(11, { pv: [50, 50], grid: 60 }), { siteAuxKw: 20 });
    expect(surplus.flows).toContainEqual({ from: 'pv', to: 'unmetered', kwh: 20 });
    expect(surplus.dq.unmetered_kwh).toBe(20);
    expect(surplus.dq.unmetered_ratio).toBeCloseTo(0.2, 6);

    const deficit = poolOf(hourRows(11, { pv: [50, 50], grid: 120 }), { siteAuxKw: 0 });
    expect(deficit.totals.unmetered_supply).toBe(20);
    expect(flowSum(deficit.flows, (f) => f.from === 'unmetered')).toBeCloseTo(20, 6);
    expect(deficit.dq.unmetered_ratio).toBeCloseTo(20 / 120, 5);
  });

  it('보조부하 계량이 없으면(siteAuxKw null) 남는 공급을 보조부하 잔여로 본다', () => {
    const day = poolOf(hourRows(11, { pv: [50, 50], grid: 70 }));
    expect(day.totals.site_aux).toBe(30);
    expect(day.dq).toMatchObject({ aux_basis: 'residual', aux_residual_kwh: 30, unmetered_kwh: 0 });
    expect(day.elzGridShare).toBeNull();
    expect(day.renewableShare).toBeNull();
  });

  it('정류기 행이 없으면 전해조 설비 전체 AC로 대신하고, 설비가 없는 원천은 완결성에서 뺀다', () => {
    const p = resolveLedgerParams();
    const ctx = createLedgerContext(DAY, ASSETS.filter((a) => a.id !== 5), hourRows(9, { pv: [300, 300], elz: 500, grid: 100 }), p.fallbackPeriodS);
    const pool = hourPool(ctx, p, DAY + 9 * 3_600_000);
    expect(pool.demand.electrolyzer).toBe(500);
    expect(pool.electrolyzerSystem).toBe(500);
    const day = energyPool(ctx, p);
    expect(day.dq.elz_flow_basis).toBe('system_total');
    expect(day.dq.completeness['h2.elz.rectifier/ac.power']).toBeUndefined();
    expect(day.dq.completeness['pv.inverter/ac.power']).toBe(0.0417); // 1/24, 소수 4자리
  });
});
