import { describe, expect, it } from 'vitest';
import { expectedEffectDefaults, verificationMetricsFor } from './action-defaults';

describe('verificationMetricsFor', () => {
  it('설비 종류의 에피소드로 계산할 수 있는 검증 지표만', () => {
    expect(verificationMetricsFor('ess.rack').map((m) => m.key)).toEqual(['ess.capacity_ah', 'ess.cell_dv_mv', 'ess.resistance_mohm']);
    expect(verificationMetricsFor('h2.elz.stack').map((m) => m.key)).toEqual(['el.v_cell_v', 'el.sec_kwh_per_kg']);
    expect(verificationMetricsFor('fc.stack')).toEqual([{ key: 'fc.v_cell_v', label: '연료전지 기준 전류밀도 셀 전압', unit: 'V' }]);
    expect(verificationMetricsFor('pv.inverter').map((m) => m.key)).toEqual(['pv.performance_index']);
    expect(verificationMetricsFor('h2.compressor').map((m) => m.key)).toEqual(['comp.sec_kwh_per_kg']);
    expect(verificationMetricsFor('fc.blower').map((m) => m.key)).toEqual(['fc.blower_specific_power']);
    expect(verificationMetricsFor('pv.plant')).toEqual([]);
    expect(verificationMetricsFor(null)).toEqual([]);
  });
});

describe('expectedEffectDefaults', () => {
  it('탐지기별 지표·방향·안정화 일수와 현재 수준 참고 문구 (최소 변화량은 채우지 않음)', () => {
    expect(expectedEffectDefaults('ess.capacity_fade', { baseline: 586.52, current: 543.14 })).toEqual({ metric: 'ess.capacity_ah', direction: 'increase', stabilizationDays: 7, levelHint: '기준 586.5 Ah → 최근 543.1 Ah' });
    expect(expectedEffectDefaults('el.voltage_rise', { baseline: 1907.55, current: 1923.8 })).toMatchObject({ metric: 'el.v_cell_v', direction: 'decrease', levelHint: '기준 1.9076 V → 최근 1.9238 V' });
    expect(expectedEffectDefaults('ess.cell_imbalance', { baseline: null, current: 31.7 })).toMatchObject({ metric: 'ess.cell_dv_mv', levelHint: null });
    expect(expectedEffectDefaults('pv.inverter_peer', { baseline: 4.18, current: 4.09 })).toBeNull();
    expect(expectedEffectDefaults('dq.gap_flatline', { baseline: 100, current: 80 })).toBeNull();
    expect(expectedEffectDefaults('el.sec_rise', { baseline: 52.3, current: 55.61 })).toMatchObject({ metric: 'el.sec_kwh_per_kg', direction: 'decrease', levelHint: '기준 52.3 kWh/kg → 최근 55.61 kWh/kg' });
    expect(expectedEffectDefaults('fc.blower_wear', { baseline: 30, current: 36 })).toMatchObject({ metric: 'fc.blower_specific_power', direction: 'decrease' });
    expect(expectedEffectDefaults('ess.resistance_growth', { baseline: 10, current: 14 })).toMatchObject({ metric: 'ess.resistance_mohm', direction: 'decrease' });
    expect(expectedEffectDefaults('tank.static_leak', { baseline: 0, current: 0.3 })).toBeNull();
  });
});
