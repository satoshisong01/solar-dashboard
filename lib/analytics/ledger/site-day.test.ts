import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR } from '../types';
import { LEDGER_DEFAULTS } from './params';
import { buildSiteEnergyDay, chainKpis, summarizeChainPeriod } from './site-day';
import { asset, CLEAR_POA, DAY, HEALTHY_H2, hoursOf, hydrogenScenario, PV_ASSETS, pvRows, row } from './test-fixtures';
import { ALLOC_VERSION, LEDGER_CALC_VERSION } from './types';

/** 연계형 하루: 9~15시 전해조 470 kW(정류기 450) + 압축기 30 kW, 17~21시 연료전지 150 kW, 수소는 HEALTHY_H2 */
function integratedDay() {
  const h2 = hydrogenScenario(HEALTHY_H2);
  const assets = [...h2.assets, asset(102, 'ELZ1/RECT1', 'h2.elz.rectifier'), asset(103, 'COMP1', 'h2.compressor'), ...PV_ASSETS, asset(104, 'MTR1', 'grid.meter')];
  const running = hoursOf(9, 16);
  const power = [
    ...running.flatMap((h) => [row(100, 'ac.power', h, 470), row(102, 'ac.power', h, 450), row(103, 'compressor.power', h, 30)]),
    ...hoursOf(17, 22).map((h) => row(101, 'fc.ac.power', h, 150)),
    ...hoursOf(0, 24).map((h) => row(104, 'ac.power', h, -100)),
  ];
  return { assets, rows: [...h2.rows, ...power, ...pvRows({ poa: CLEAR_POA, pr: 0.8 })] };
}

describe('buildSiteEnergyDay', () => {
  it('연계형 하루: 버전·날짜, 체인 KPI(SEC·kg/MWh·P2P), 에너지·수소·PV 결과를 한 행으로 묶는다', () => {
    const { assets, rows } = integratedDay();
    const day = buildSiteEnergyDay({ dayStart: DAY, assets, rows, prRef: { value: 0.8, method: 'params' } });
    expect(day).toMatchObject({ day: '2026-06-15', alloc_version: ALLOC_VERSION, calc_version: LEDGER_CALC_VERSION });
    expect(ALLOC_VERSION).toBe('pool_hourly@1');
    expect(day.energy_kwh).toMatchObject({ electrolyzer: 7 * 450, electrolyzer_system: 7 * 470, compressor: 7 * 30, fc: 5 * 150, grid_import: 2400 });
    expect(day.h2_kg.produced).toBeCloseTo(63, 6);
    expect(day.elz_sec_kwh_per_kg).toBeCloseTo(3290 / 63, 3);
    expect(day.fc_kg_per_mwh).toBeCloseTo(60, 3);
    // P2P = 750 / (45 kg × (3290 + 210) kWh / 63 kg) = 750 / 2500
    expect(day.p2p_efficiency).toBeCloseTo(0.3, 4);
    expect(day.elz_grid_share).not.toBeNull();
    expect((day.elz_grid_share ?? 0) + (day.renewable_share ?? 0)).toBeCloseTo(1, 3);
    expect(day.pv_loss_kwh?.unexplained).toBeCloseTo(0, 3);
    expect(day.dq.energy.aux_basis).toBe('residual');
    expect(day.dq.h2.completeness).toBe(1);
    expect(JSON.parse(JSON.stringify(day))).toEqual(day);
  });

  it('태양광·ESS 사이트는 수소 원장·체인 KPI가 null이고 PR_ref가 없으면 PV 분해도 null', () => {
    const day = buildSiteEnergyDay({ dayStart: DAY, assets: PV_ASSETS, rows: pvRows({ poa: CLEAR_POA, pr: 0.8 }), prRef: null });
    expect(day.h2_kg.produced).toBeNull();
    expect(day.h2_kg.vented_est).toBeNull();
    expect([day.elz_sec_kwh_per_kg, day.fc_kg_per_mwh, day.p2p_efficiency, day.elz_grid_share, day.renewable_share, day.pv_loss_kwh]).toEqual([null, null, null, null, null, null]);
    expect(day.dq.pv.reason).toBe('pr_ref_missing');
    expect(day.flows_kwh.every((f) => f.from === 'pv')).toBe(true);
  });

  it('KST 0시가 아닌 날짜, 같은 설비·메트릭·시각 행 중복은 오류', () => {
    expect(() => buildSiteEnergyDay({ dayStart: DAY + MS_PER_HOUR, assets: PV_ASSETS, rows: [], prRef: null })).toThrow(RangeError);
    const dup = [row(21, 'ac.power', 10, 1), row(21, 'ac.power', 10, 2)];
    expect(() => buildSiteEnergyDay({ dayStart: DAY, assets: PV_ASSETS, rows: dup, prRef: null })).toThrow('두 개');
    // 원장이 읽지 않는 메트릭(한정자별 포인트)은 중복이어도 무시한다
    const other = [row(21, 'water.conductivity', 10, 1), row(21, 'water.conductivity', 10, 2)];
    expect(() => buildSiteEnergyDay({ dayStart: DAY, assets: PV_ASSETS, rows: other, prRef: null })).not.toThrow();
  });
});

describe('체인 KPI 기간 합', () => {
  it('chainKpis: 최소량 미만이면 null', () => {
    const base = { producedKg: 63, fcConsumedKg: 45, electrolyzerKwh: 3290, compressorKwh: 210, fcAcKwh: 750 };
    expect(chainKpis(base, LEDGER_DEFAULTS)).toEqual({ elzSecKwhPerKg: 52.222, fcKgPerMwh: 60, p2pEfficiency: 0.3 });
    expect(chainKpis({ ...base, producedKg: 0.5 }, LEDGER_DEFAULTS)).toEqual({ elzSecKwhPerKg: null, fcKgPerMwh: 60, p2pEfficiency: null });
    expect(chainKpis({ ...base, fcAcKwh: 0, fcConsumedKg: null }, LEDGER_DEFAULTS)).toMatchObject({ fcKgPerMwh: null, p2pEfficiency: null });
  });

  it('summarizeChainPeriod: 수소 원장이 빈 날은 빼고 기간 합으로 P2P·잔차를 낸다', () => {
    const { assets, rows } = integratedDay();
    const day = buildSiteEnergyDay({ dayStart: DAY, assets, rows, prRef: null });
    const empty = buildSiteEnergyDay({ dayStart: DAY, assets: PV_ASSETS, rows: [], prRef: null });
    const summary = summarizeChainPeriod([day, day, empty]);
    expect(summary).toMatchObject({ daysUsed: 2, producedKg: 126, fcConsumedKg: 90 });
    expect(summary.p2pEfficiency).toBeCloseTo(0.3, 4);
    expect(Math.abs(summary.residualPct ?? 99)).toBeLessThan(0.5);
    expect(summarizeChainPeriod([empty])).toMatchObject({ daysUsed: 0, residualPct: null, p2pEfficiency: null });
  });
});
