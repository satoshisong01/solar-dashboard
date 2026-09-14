import { describe, expect, it } from 'vitest';
import { expectedEffectDefaults, verificationMetricsFor } from './action-defaults';

describe('verificationMetricsFor', () => {
  it('설비 종류의 에피소드로 계산할 수 있는 검증 지표만', () => {
    expect(verificationMetricsFor('ess.rack').map((m) => m.key)).toEqual(['ess.capacity_ah', 'ess.cell_dv_mv']);
    expect(verificationMetricsFor('h2.elz.stack').map((m) => m.key)).toEqual(['el.v_cell_v']);
    expect(verificationMetricsFor('fc.stack')).toEqual([{ key: 'fc.v_cell_v', label: '연료전지 기준 전류밀도 셀 전압', unit: 'V' }]);
    expect(verificationMetricsFor('pv.inverter')).toEqual([]);
    expect(verificationMetricsFor('h2.compressor')).toEqual([]);
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
  });
});
