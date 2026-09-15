import { describe, expect, it } from 'vitest';
import { H2_KG_PER_AMP_HOUR_PER_CELL as SIM_H2_KG_PER_AMP_HOUR_PER_CELL } from '@/lib/sim/models/common';
import { ABEL_NOBLE_DEFAULTS, H2_COVOLUME_DEFAULT, h2DensityKgM3 as h2DensityAbelNoble, h2MassKg as h2MassAbelNobleKg, h2PressureBar as h2PressureAbelNobleBar, H2_SPECIFIC_GAS_CONSTANT_DEFAULT as H2_SPECIFIC_GAS_CONSTANT } from '../detectors/hydrogen-eos';
import { TANK_STATIC_LEAK_DEFAULTS } from '../detectors/tank-static-leak';
import { createLedgerContext } from './hourly';
import { H2_EOS_VERSION, H2_KG_PER_AMP_HOUR_PER_CELL, hydrogenLedger } from './hydrogen';
import { resolveLedgerParams } from './params';
import { asset, DAY, HEALTHY_H2, hoursOf, hydrogenScenario, row, type H2DayScenario } from './test-fixtures';
import type { LedgerAsset, LedgerHourRow } from './types';

const ledgerOf = (assets: readonly LedgerAsset[], rows: readonly LedgerHourRow[], params = {}) => {
  const p = resolveLedgerParams(params);
  return hydrogenLedger(createLedgerContext(DAY, assets, rows, p.fallbackPeriodS), p);
};

const runScenario = (scenario: H2DayScenario) => {
  const { assets, rows } = hydrogenScenario(scenario);
  return ledgerOf(assets, rows);
};

describe('Abel–Noble 상태식 (tank.static_leak 탐지기와 같은 수식·상수)', () => {
  it('원장 저장량 변화와 누설 탐지기가 같은 상수·함수를 쓴다', () => {
    expect(TANK_STATIC_LEAK_DEFAULTS.specificGasConstant).toBe(ABEL_NOBLE_DEFAULTS.specificGasConstant);
    expect(TANK_STATIC_LEAK_DEFAULTS.coVolume).toBe(ABEL_NOBLE_DEFAULTS.coVolume);
    const { assets, rows } = hydrogenScenario(HEALTHY_H2);
    const tankIds = assets.filter((a) => a.classKey === 'h2.storage.tank').map((a) => a.id);
    const lastOf = (id: number, metric: string, hour: number) => rows.find((r) => r.assetId === id && r.metricKey === metric && r.hourStart === DAY + hour * 3_600_000)?.last ?? 0;
    const massAt = (id: number, hour: number) => h2MassAbelNobleKg(lastOf(id, 'tank.pressure', hour), lastOf(id, 'tank.temp', hour), 1.85);
    const detectorDelta = tankIds.reduce((sum, id) => sum + massAt(id, 23) - massAt(id, -1), 0);
    expect(ledgerOf(assets, rows).ledger.stored_delta).toBeCloseTo(detectorDelta, 3);
  });

  it('상수와 기준값을 고정한다 — 바꾸면 탐지기 쪽도 함께 바꿔야 한다', () => {
    expect(H2_COVOLUME_DEFAULT).toBe(7.691e-3);
    expect(H2_SPECIFIC_GAS_CONSTANT).toBeCloseTo(4124.4829, 3);
    expect(H2_EOS_VERSION).toBe('abel_noble@1');
    // ρ = P / (R_s·T + b·P)
    expect(h2DensityAbelNoble(350, 15)).toBeCloseTo(24.01117, 4);
    expect(h2DensityAbelNoble(700, 15)).toBeCloseTo(40.53648, 4);
    expect(h2MassAbelNobleKg(200, 20, 7.4)).toBeCloseTo(14.67446 * 7.4, 3);
  });

  it('공개 물성 참고값(15 °C, 350·700 bar 약 24·40.2 kg/m³)과 3% 안, 저압(1 bar)에서는 이상기체와 0.1% 안', () => {
    expect(Math.abs(h2DensityAbelNoble(350, 15) / 24.0 - 1)).toBeLessThan(0.03);
    expect(Math.abs(h2DensityAbelNoble(700, 15) / 40.2 - 1)).toBeLessThan(0.03);
    const ideal = 1e5 / (H2_SPECIFIC_GAS_CONSTANT * 273.15);
    expect(Math.abs(h2DensityAbelNoble(1, 0) / ideal - 1)).toBeLessThan(1e-3);
  });

  it('질량 ↔ 압력 역함수, 음수 압력은 0, 절대 0도 이하는 오류', () => {
    for (const bar of [30, 220, 450]) expect(h2PressureAbelNobleBar(h2MassAbelNobleKg(bar, 18, 1.85), 18, 1.85)).toBeCloseTo(bar, 9);
    expect(h2DensityAbelNoble(-1, 20)).toBe(0);
    expect(() => h2DensityAbelNoble(100, -274)).toThrow(RangeError);
    expect(() => h2PressureAbelNobleBar(200, 20, 1)).toThrow(RangeError);
  });

  it('패러데이 원단위는 시뮬레이터 상수와 같다', () => {
    expect(H2_KG_PER_AMP_HOUR_PER_CELL).toBeCloseTo(3.7608e-5, 9);
    expect(H2_KG_PER_AMP_HOUR_PER_CELL).toBe(SIM_H2_KG_PER_AMP_HOUR_PER_CELL);
  });
});

describe('hydrogenLedger', () => {
  it('건강한 합성 하루: 생산 63 − 소비 45 = 저장 증가 18, |잔차| < 0.5%', () => {
    const { assets, rows } = hydrogenScenario(HEALTHY_H2);
    const { ledger, dq } = ledgerOf(assets, rows);
    expect(ledger.produced).toBeCloseTo(63, 6);
    expect(ledger.fc_consumed).toBeCloseTo(45, 6);
    expect(ledger.stored_delta).toBeCloseTo(18, 1);
    expect(ledger.vented_est).toBe(0);
    expect(Math.abs(ledger.residual_pct ?? 99)).toBeLessThan(0.5);
    expect(ledger.method).toEqual({ produced: 'meter', fc_consumed: 'meter', stored_delta: 'abel_noble@1', vented: 'not_estimated' });
    expect(dq.completeness).toBe(1);
    expect(dq.purge_count_missing).toBe(false);
    // 판별 체크 보조값: 스택이 없으면 이론 생산량 없음, 탱크 온도 끝 − 시작 평균 (fixture 온도 오프셋 평균 0.025 °C는 상쇄)
    expect(ledger.aux.faraday_expected).toBeNull();
    expect(ledger.aux.purge_count).toBeNull();
    expect(ledger.aux.tank_temp_delta_c).toBeCloseTo(20 + 5 * Math.sin((2 * Math.PI * 16) / 24) - (20 + 5 * Math.sin((2 * Math.PI * -8) / 24)), 2);
  });

  it('누설 2 kg/일 주입 → 잔차가 누설량만큼', () => {
    const healthy = runScenario(HEALTHY_H2).ledger;
    const leaking = runScenario({ ...HEALTHY_H2, leakKg: 2 }).ledger;
    expect((leaking.residual ?? 0) - (healthy.residual ?? 0)).toBeCloseTo(2, 2);
    expect(leaking.residual).toBeCloseTo(2, 1);
    expect(leaking.residual_pct).toBeCloseTo((2 / 63) * 100, 0);
  });

  it('배출 추정: 퍼지 증가 × kg/회 + 건조기 손실률 × 생산', () => {
    const { assets, rows } = hydrogenScenario(HEALTHY_H2);
    const purgeRows = [row(101, 'purge.count', -1, 1000, { last: 1000 }), row(101, 'purge.count', 12, 1100, { first: 1050, last: 1150 }), row(101, 'purge.count', 23, 1350, { first: 1340, last: 1350 })];
    const { ledger, dq } = ledgerOf(assets, [...rows, ...purgeRows], { kgPerPurge: 0.002, dryerLossFraction: 0.02 });
    expect(ledger.vented_est).toBeCloseTo(350 * 0.002 + 0.02 * 63, 6);
    expect(ledger.aux.purge_count).toBe(350);
    expect(ledger.method.vented).toBe('params');
    const base = ledgerOf(assets, rows).ledger;
    expect((base.residual ?? 0) - (ledger.residual ?? 0)).toBeCloseTo(0.7 + 1.26, 3);
    expect(dq.purge_count_missing).toBe(false);
    expect(ledgerOf(assets, rows, { kgPerPurge: 0.002 }).dq.purge_count_missing).toBe(true);
  });

  it('유량계가 없으면 패러데이 추정(셀 수 × 전류), 소비·저장 데이터가 없으면 잔차 null', () => {
    const stack = asset(5, 'ELZ1/STACK1', 'h2.elz.stack', { cell_count: 210 });
    const rows = hoursOf(9, 12).map((h) => row(5, 'stack.current', h, 1000));
    const { ledger } = ledgerOf([asset(4, 'ELZ1', 'h2.elz'), stack], rows, { faradayEfficiency: 0.98 });
    expect(ledger.produced).toBeCloseTo(3 * 210 * 1000 * 0.98 * H2_KG_PER_AMP_HOUR_PER_CELL, 4);
    expect(ledger.aux.faraday_expected).toBeCloseTo(3 * 210 * 1000 * H2_KG_PER_AMP_HOUR_PER_CELL, 4);
    expect(ledger.method.produced).toBe('faraday_estimate');
    expect(ledger.fc_consumed).toBeNull();
    expect(ledger.stored_delta).toBeNull();
    expect(ledger.residual).toBeNull();
    expect(ledger.residual_pct).toBeNull();
    expect(ledgerOf([asset(4, 'ELZ1', 'h2.elz'), asset(6, 'ELZ1/STACK1', 'h2.elz.stack')], rows).ledger.produced).toBeNull();
  });

  it('탱크 하나라도 경계값이 없으면 저장 변화 null, 수소 설비가 없는 사이트는 전부 null', () => {
    const { assets, rows } = hydrogenScenario(HEALTHY_H2);
    const withoutTank = rows.filter((r) => !(r.assetId === 110 && r.metricKey === 'tank.temp'));
    expect(ledgerOf(assets, withoutTank).ledger.stored_delta).toBeNull();
    const pvOnly = ledgerOf([asset(1, 'PV1/INV01', 'pv.inverter')], []);
    expect(pvOnly.ledger).toEqual({ produced: null, fc_consumed: null, stored_delta: null, vented_est: null, residual: null, residual_pct: null, method: { produced: null, fc_consumed: null, stored_delta: null, vented: 'not_estimated' }, aux: { faraday_expected: null, purge_count: null, tank_temp_delta_c: null } });
    expect(pvOnly.dq.completeness).toBeNull();
  });

  it('생산·소비가 거의 없는 날은 분모 하한(residualFloorKg)을 쓴다', () => {
    const idle = { producedKgH: hoursOf(0, 24).map(() => 0), fcKgH: hoursOf(0, 24).map(() => 0), leakKg: 0.5, startMassKg: 110 };
    const { ledger } = runScenario(idle);
    expect(ledger.residual).toBeCloseTo(0.5, 1);
    expect(ledger.residual_pct).toBeCloseTo((ledger.residual ?? 0) * 100, 1);
  });
});
