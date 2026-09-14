import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { DAY0, elRuns, fcRuns } from './test-fixtures';
import { elVoltageRise, fcVoltageDecay } from './stack-detectors';

const NOW = DAY0 + 400 * 86_400_000;
const ctx = (seed = 1, extra = {}) => ({ now: NOW, rng: createRng(seed), params: {}, ...extra });

describe('el.voltage_rise@1', () => {
  it('셀 전압 +25 µV/h 주입을 전류밀도·온도 차이를 보정해 25 ± 3 µV/h로 추정하고 severity 3', () => {
    const result = elVoltageRise.detect({ assetId: 31, episodes: elRuns({ count: 400, startHours: 1200, endHours: 2400, rateUvPerH: 25, seed: 2 }) }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'el.voltage_rise', failureMode: 'el.stack_voltage_degradation', severity: 3, effect: { unit: 'µV/h', metric: 'v_cell_rise_rate', levelUnit: 'mV' } });
    expect(finding?.effect.value).toBeGreaterThan(22);
    expect(finding?.effect.value).toBeLessThan(28);
    expect(finding?.effect.ciLow).toBeGreaterThan(0);
    expect(finding?.summary).toMatch(/µV\/h\(95% CI/);
    const evidence = finding?.evidence as Record<string, Record<string, unknown>>;
    expect(evidence.corrections?.slope_j_mv_per_acm2).toBeGreaterThan(200); // 주입 250 mV/(A/cm²), bin 안 좁은 j 범위라 추정 잡음이 크다
    expect(evidence.corrections?.slope_j_mv_per_acm2).toBeLessThan(300);
    expect(JSON.stringify(finding?.evidence).length).toBeLessThan(20_000);
  });

  it('대조군(기본 열화 4 µV/h)은 0건, break-in 이전뿐이면 insufficient', () => {
    expect(elVoltageRise.detect({ assetId: 31, episodes: elRuns({ count: 300, startHours: 1200, endHours: 2400, rateUvPerH: 4, seed: 3 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
    const early = elVoltageRise.detect({ assetId: 31, episodes: elRuns({ count: 100, startHours: 10, endHours: 900, rateUvPerH: 50, seed: 4 }) }, ctx());
    expect(early.status).toBe('insufficient');
    if (early.status === 'insufficient') expect(early.reason).toContain('break-in');
    const shortSpan = elVoltageRise.detect({ assetId: 31, episodes: elRuns({ count: 100, startHours: 1200, endHours: 1250, rateUvPerH: 50, seed: 5 }) }, ctx());
    expect(shortSpan.status === 'insufficient' && shortSpan.reason).toContain('운전시간 범위 부족');
  });

  it('결정성과 기준선 재설정', () => {
    const episodes = elRuns({ count: 200, startHours: 1200, endHours: 2400, rateUvPerH: 45, seed: 6 });
    const a = elVoltageRise.detect({ assetId: 31, episodes }, ctx(9));
    expect(a).toEqual(elVoltageRise.detect({ assetId: 31, episodes }, ctx(9)));
    expect(a.status === 'ok' && a.findings[0]?.severity).toBe(4);
    const reset = elVoltageRise.detect({ assetId: 31, episodes }, ctx(9, { baselineResetAt: NOW }));
    expect(reset.status).toBe('insufficient');
  });
});

describe('fc.voltage_decay@1', () => {
  it('기준 전류밀도 전압 −30 µV/h 감소와 블로워 전력 증가 동반을 찾는다', () => {
    const result = fcVoltageDecay.detect({ assetId: 41, episodes: fcRuns({ count: 400, startHours: 600, endHours: 1800, rateUvPerH: -30, seed: 7, blowerRise: 0.25 }) }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'fc.voltage_decay', failureMode: 'fc.stack_voltage_decay', severity: 3, effect: { metric: 'v_cell_decay_rate' } });
    expect(finding?.effect.value).toBeGreaterThan(26);
    expect(finding?.effect.value).toBeLessThan(34);
    const checks = (finding?.evidence.checks ?? []) as readonly { id: string; status: string }[];
    expect(checks.find((c) => c.id === 'blower_power_increase')?.status).toBe('supports');
    expect(checks.find((c) => c.id === 'stack_temperature_shift')?.status).toBe('refutes');
    expect(finding?.summary).toContain('블로워 전력 증가 동반');
  });

  it('대조군(기본 감쇠 6 µV/h, 블로워 그대로)은 0건', () => {
    expect(fcVoltageDecay.detect({ assetId: 41, episodes: fcRuns({ count: 300, startHours: 600, endHours: 1800, rateUvPerH: -6, seed: 8 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
  });
});
