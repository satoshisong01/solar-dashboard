import { describe, expect, it } from 'vitest';
import type { PvDayEpisode } from '../episodes/pv';
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import { availability, elzSec, elzVCellRef, essRte, fcKgPerMwh, fcVCellRef, inverterPeerRatios, KPI_KEYS, pvDayAvailability, pvKwh, specificYield } from './daily';

const DQ = { completeness: 1, missing_ratio: 0, bad_ratio: 0 };
const base = { assetId: 1, start: 0, end: 600_000, dq: DQ, open: false, valid: true, invalidReason: null, conditions: { j_bin: 1, t_bin: 60 } };

function elRun(features: Partial<ElSteadyEpisode['features']>, valid = true): ElSteadyEpisode {
  const defaults = { j_mean: 1, i_mean: 550, v_cell_mean: 1.8, t_stack_mean: 60, h2_kg: 1.5, op_hours_cum: 100, duration_s: 600, energy_kwh: 75, dc_kwh: 70, sec_kwh_per_kg: 50 };
  return { ...base, kind: 'el.steady_run', extractorVersion: 'el.steady_run@1', features: { ...defaults, ...features }, valid, invalidReason: valid ? null : 'open' };
}

function fcRun(features: Partial<FcSteadyEpisode['features']>): FcSteadyEpisode {
  const defaults = { j_mean: 0.5, i_mean: 400, v_cell_mean: 0.7, v_cell_at_jref: 0.7, t_stack_mean: 65, h2_kg: 2, op_hours_cum: 100, duration_s: 600, ac_kwh: 33, kg_per_mwh: 60, blower_power_mean: 5 };
  return { ...base, kind: 'fc.steady_run', extractorVersion: 'fc.steady_run@1', features: { ...defaults, ...features } };
}

describe('pvKwh / specificYield / inverterPeerRatios', () => {
  it('시간 평균 kW 합과 완결성', () => {
    const rows = [
      { hourStart: 0, n: 60, nGood: 60, avg: 100 },
      { hourStart: 1, n: 60, nGood: 30, avg: 50 },
      { hourStart: 2, n: 60, nGood: 0, avg: null },
    ];
    const value = pvKwh(rows, 60);
    expect(value).toEqual({ key: 'pv.kwh', value: 150, unit: 'kWh', n: 2, dqCompleteness: 90 / 1440 });
    expect(specificYield(value, 50)).toMatchObject({ key: KPI_KEYS.specific_yield_kwh_kwp, value: 3, unit: 'kWh/kWp' });
    expect(specificYield(value, 0).value).toBeNull();
    expect(pvKwh([], 60).value).toBeNull();
  });

  it('동종 중앙값 대비 비율, 3대 미만이면 null', () => {
    const ratios = inverterPeerRatios([
      { assetId: 1, kwh: 1000, dcKwp: 250 },
      { assetId: 2, kwh: 1000, dcKwp: 250 },
      { assetId: 3, kwh: 900, dcKwp: 250 },
      { assetId: 4, kwh: null, dcKwp: 250 },
    ]);
    expect(ratios.get(3)?.value).toBeCloseTo(0.9, 12);
    expect(ratios.get(1)?.value).toBe(1);
    expect(ratios.get(4)?.value).toBeNull();
    expect(inverterPeerRatios([{ assetId: 1, kwh: 1, dcKwp: 1 }]).get(1)?.value).toBeNull();
  });
});

describe('essRte', () => {
  it('저장량 변화를 보정한 왕복효율', () => {
    const value = essRte({ chargeKwh: 900, dischargeKwh: 765, socStartPct: 20, socEndPct: 30, usableKwh: 1000, dqCompleteness: 0.99 });
    expect(value.value).toBeCloseTo(765 / 800, 12);
    expect(essRte({ chargeKwh: 100, dischargeKwh: 80, socStartPct: 50, socEndPct: 50, usableKwh: 1000, dqCompleteness: 1 }).value).toBeNull();
    expect(essRte({ chargeKwh: 900, dischargeKwh: 765, socStartPct: null, socEndPct: 30, usableKwh: 1000, dqCompleteness: 1 }).value).toBeNull();
  });
});

describe('수소 KPI', () => {
  it('전해조 SEC·기준 셀 전압은 유효 구간만 쓴다', () => {
    const runs = [elRun({}), elRun({ energy_kwh: 110, h2_kg: 2, j_mean: 1.04, v_cell_mean: 1.82 }), elRun({ h2_kg: 0 }), elRun({ energy_kwh: 999 }, false), elRun({ j_mean: 1.5, v_cell_mean: 2 })];
    expect(elzSec(runs)).toMatchObject({ key: 'elz.sec_kwh_per_kg', unit: 'kWh/kg', n: 3 });
    expect(elzSec(runs).value).toBeCloseTo((75 + 110 + 75) / (1.5 + 2 + 1.5), 12);
    expect(elzVCellRef(runs, { jRefAcm2: 1, jToleranceAcm2: 0.05 })).toMatchObject({ value: 1.8, n: 3, dqCompleteness: 1 });
    expect(elzVCellRef([], { jRefAcm2: 1, jToleranceAcm2: 0.05 }).value).toBeNull();
    expect(elzSec([]).value).toBeNull();
  });

  it('연료전지 kg/MWh·기준 셀 전압', () => {
    const runs = [fcRun({}), fcRun({ h2_kg: 4, ac_kwh: 67, v_cell_at_jref: 0.69 }), fcRun({ v_cell_at_jref: null, ac_kwh: null })];
    expect(fcKgPerMwh(runs).value).toBeCloseTo((6 / 100) * 1000, 12);
    expect(fcVCellRef(runs).value).toBeCloseTo(0.695, 12);
    expect(fcVCellRef(runs).n).toBe(2);
    expect(fcKgPerMwh([]).value).toBeNull();
    expect(fcVCellRef([]).value).toBeNull();
  });
});

describe('availability', () => {
  it('제외 시간을 뺀 가용률, 분모가 0이면 null', () => {
    expect(availability({ periodHours: 24, downtimeHours: 2, excludedHours: 4, dqCompleteness: 1 }).value).toBeCloseTo(0.9, 12);
    expect(availability({ periodHours: 4, downtimeHours: 0, excludedHours: 4, dqCompleteness: null }).value).toBeNull();
    const day = { features: { operating_h: 11.5, stopped_h: 0.5 }, dq: DQ } as unknown as PvDayEpisode;
    expect(pvDayAvailability(day).value).toBeCloseTo(11.5 / 12, 12);
  });
});
