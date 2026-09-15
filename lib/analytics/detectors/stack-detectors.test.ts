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

  it('변화점 이후 운전시간이 충분하면 변화점 이후 기울기를 효과로 쓴다 (기본 4 µV/h 600 h 뒤 25 µV/h 주입: 전체 기울기 편향 해소)', () => {
    const kinkHours = 1800;
    const base = elRuns({ count: 420, startHours: 1200, endHours: 3000, rateUvPerH: 0, seed: 12, noiseMv: 0.2 });
    const episodes = base.map((e) => {
      const h = e.features.op_hours_cum ?? 0;
      const drift = 4e-6 * (Math.min(h, kinkHours) - 1200) + 25e-6 * Math.max(0, h - kinkHours);
      return { ...e, features: { ...e.features, v_cell_mean: (e.features.v_cell_mean ?? 0) + drift } };
    });
    const result = elVoltageRise.detect({ assetId: 31, episodes }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    const trend = (finding?.evidence as Record<string, Record<string, unknown>>).trend ?? {};
    // 전체 기울기는 앞 600 h의 4 µV/h가 섞여 25보다 작다 (P2에서 21.4 vs 25로 보고된 편향)
    expect((trend.full as Record<string, number>).slope_uv_per_h).toBeLessThan(22.5);
    expect(trend.basis).toBe('post_change');
    expect(finding?.effect.value).toBeGreaterThan(22.5);
    expect(finding?.effect.value).toBeLessThan(27.5);
    expect((trend.pre_change as Record<string, number>).slope_uv_per_h).toBeLessThan(12);
    expect(Number(trend.change_start_op_h)).toBeGreaterThan(1500);
    expect(finding?.summary).toContain('변화점');
    // 변화점 이후 운전시간이 모자라면(minHoursAfterChange) 전체 기울기
    const short = elVoltageRise.detect({ assetId: 31, episodes }, ctx(1, { params: { minHoursAfterChange: 5000 } }));
    const shortTrend = short.status === 'ok' ? ((short.findings[0]?.evidence as Record<string, Record<string, unknown>>).trend ?? {}) : {};
    expect(shortTrend.basis).toBe('full');
  });

  it('전력 설정값 운전: 정류기 효율 저하로 같은 전력의 전류밀도가 5% 옮겨 가도 기준 구간 기울기 보정(기본)은 +25 µV/h를 찾고, 전류밀도 bin 방식은 놓친다', () => {
    // 전류밀도 1.905~1.995 A/cm² 좁은 운전점 → 30~70% 구간에서 5% 낮아져 1.9 bin에서 1.8 bin으로 옮겨 감 (분극 기울기 250 mV/(A/cm²))
    const base = elRuns({ count: 400, startHours: 1200, endHours: 2400, rateUvPerH: 25, seed: 2 });
    const episodes = base.map((e, i) => {
      const shrink = 1 - 0.05 * Math.min(1, Math.max(0, (i / base.length - 0.3) / 0.4));
      const j = (1.905 + (0.09 * (e.features.j_mean - 0.6)) / 0.8) * shrink;
      return { ...e, features: { ...e.features, j_mean: j, v_cell_mean: (e.features.v_cell_mean ?? 0) - 0.25 * (e.features.j_mean - j) }, conditions: { ...e.conditions, j_bin: Math.floor(j * 10) / 10 } };
    });
    const reference = elVoltageRise.detect({ assetId: 31, episodes }, ctx());
    expect(reference.status === 'ok' && reference.findings[0]?.effect.value).toBeGreaterThan(21);
    expect(reference.status === 'ok' && reference.findings[0]?.effect.value).toBeLessThan(29);
    expect(elVoltageRise.detect({ assetId: 31, episodes }, ctx(1, { params: { currentDensityMode: 'bins' } }))).toEqual({ status: 'ok', findings: [] });
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

  it('정출력 운전으로 전압 감소와 함께 전류밀도·온도가 오르는 공선성에서도 −40 µV/h를 찾는다', () => {
    const constantPower = fcRuns({ count: 300, startHours: 600, endHours: 1800, rateUvPerH: 0, seed: 9 }).map((e, i) => {
      const drop = 40e-6 * (1200 * i) / 299;
      const j = 0.7 + 0.8 * drop;
      const v = 0.72 - drop - 0.2 * (j - 0.7);
      return { ...e, features: { ...e.features, j_mean: j, v_cell_mean: v, v_cell_at_jref: v + 0.2 * (j - 0.6), t_stack_mean: 68 + 10 * drop }, conditions: { j_bin: Math.floor(j * 10) / 10, t_bin: 65 } };
    });
    const result = fcVoltageDecay.detect({ assetId: 41, episodes: constantPower }, ctx());
    expect(result.status === 'ok' && result.findings[0]?.effect.value).toBeCloseTo(40, 0);
    const legacy = fcVoltageDecay.detect({ assetId: 41, episodes: constantPower }, ctx(1, { params: { correctCurrentDensity: true, correctTemperature: true } }));
    expect(legacy.status === 'ok' ? legacy.findings.length : 0).toBe(0);
  });

  it('변화점 이후 기울기: 기본 감쇠 6 µV/h 400 h 뒤 30 µV/h로 바뀌면 30 ± 3 µV/h (전체 기울기는 더 작다)', () => {
    const kinkHours = 1000;
    const episodes = fcRuns({ count: 420, startHours: 600, endHours: 2400, rateUvPerH: 0, seed: 13, noiseMv: 0.2 }).map((e) => {
      const h = e.features.op_hours_cum ?? 0;
      const drop = 6e-6 * (Math.min(h, kinkHours) - 600) + 30e-6 * Math.max(0, h - kinkHours);
      return { ...e, features: { ...e.features, v_cell_at_jref: (e.features.v_cell_at_jref ?? 0) - drop } };
    });
    const result = fcVoltageDecay.detect({ assetId: 41, episodes }, ctx());
    const finding = result.status === 'ok' ? result.findings[0] : undefined;
    const trend = (finding?.evidence as Record<string, Record<string, unknown>> | undefined)?.trend ?? {};
    expect(trend.basis).toBe('post_change');
    expect(finding?.effect.value).toBeGreaterThan(27);
    expect(finding?.effect.value).toBeLessThan(33);
    expect(-((trend.full as Record<string, number>).slope_uv_per_h ?? 0)).toBeLessThan(finding?.effect.value ?? 0);
  });

  it('대조군(기본 감쇠 6 µV/h, 블로워 그대로)은 0건', () => {
    expect(fcVoltageDecay.detect({ assetId: 41, episodes: fcRuns({ count: 300, startHours: 600, endHours: 1800, rateUvPerH: -6, seed: 8 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
  });
});
