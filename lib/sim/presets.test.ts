import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { kstHourOfDay, MS_PER_DAY, MS_PER_HOUR } from './math';
import { EVAL_PRESET, evalRunPlans, presetScenarios, SCENARIO_PRESETS } from './presets';
import { DEMO_TANK_LEAK_SAFETY_KG_PER_DAY } from './presets-demo';
import { planScenarios, scenarioOriginMs, type Scenario } from './scenarios';

const TO = Date.parse('2026-09-14T10:00:00Z');
const window = (days: number) => ({ fromMs: TO - days * MS_PER_DAY, toMs: TO });
const ALL = ['SIM-A', 'SIM-B', 'SIM-C'];

const startOf = (scenario: Scenario): number | null => {
  if (scenario.kind === 'safety.h2_leak_alarm') return Number(scenario.at);
  if ('start' in scenario && scenario.start !== undefined) return Number(scenario.start);
  return null;
};

describe('presetScenarios', () => {
  it('healthy는 시나리오가 없다', () => {
    expect(presetScenarios('healthy', ALL, window(30))).toEqual([]);
  });

  it('dq: 전 사이트 중복 5%, SIM-B 6시간 단절, SIM-A +200초 시계 오차 구간·센서 고착, SIM-B 스파이크·누출 경보', () => {
    const scenarios = presetScenarios('dq', ALL, window(30));

    expect(scenarios.filter((s) => s.kind === 'dq.duplicate_batches')).toEqual(ALL.map((site) => ({ kind: 'dq.duplicate_batches', site, ratio: 0.05 })));
    expect(scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dq.gateway_outage', site: 'SIM-B', durationS: 6 * 3_600 }),
        expect.objectContaining({ kind: 'dq.clock_skew', site: 'SIM-A', skewS: 200, durationS: 12 * 3_600 }),
        expect.objectContaining({ kind: 'dq.stuck_sensor', site: 'SIM-A', sourceKey: 'WX1/POA' }),
        expect.objectContaining({ kind: 'dq.spike', site: 'SIM-B', sourceKey: 'H2BANK1/TANK1/P' }),
        expect.objectContaining({ kind: 'safety.h2_leak_alarm', site: 'SIM-B' }),
      ]),
    );
    expect(scenarios.some((s) => 'site' in s && s.site === 'SIM-C' && s.kind !== 'dq.duplicate_batches')).toBe(false);
    // 시뮬레이터 검증을 통과한다 (태그·검지기 존재)
    expect(() => planScenarios(SIM_SITES, scenarios)).not.toThrow();
  });

  it.each([3, 7, 30])('dq %i일: 모든 시작 시각이 적재 구간 안이고, 단절·고착·경보는 KST 낮 시간이다', (days) => {
    const { fromMs, toMs } = window(days);
    const scenarios = presetScenarios('dq', ALL, { fromMs, toMs });
    const byKind = (kind: Scenario['kind']) => scenarios.find((s) => s.kind === kind);

    for (const scenario of scenarios) {
      const start = startOf(scenario);
      if (start === null) continue;
      expect(start, scenario.kind).toBeGreaterThanOrEqual(fromMs);
      expect(start, scenario.kind).toBeLessThan(toMs);
    }
    const outage = byKind('dq.gateway_outage');
    const stuck = byKind('dq.stuck_sensor');
    const alarm = byKind('safety.h2_leak_alarm');
    expect([outage, stuck, alarm].map((s) => (s ? kstHourOfDay(startOf(s) ?? 0) : null))).toEqual([10, 9, 14.5]);
    // 서로 다른 구간에 둔다: 단절이 끝난 뒤 시계 오차, 그 뒤 경보
    const skew = byKind('dq.clock_skew');
    expect((startOf(skew ?? { kind: 'healthy' }) ?? 0) - (startOf(outage ?? { kind: 'healthy' }) ?? 0)).toBeGreaterThanOrEqual(6 * MS_PER_HOUR);
  });

  it('dq는 SIM-A·SIM-B가 모두 있고 3일 이상이어야 한다', () => {
    expect(() => presetScenarios('dq', ['SIM-A', 'SIM-C'], window(30))).toThrow('SIM-B');
    expect(() => presetScenarios('dq', ALL, window(2))).toThrow('3일 이상');
  });
});

describe('presetScenarios — demo120', () => {
  it('SIM-A 용량·인버터·셀 불균형, SIM-B 전해조·연료전지·SOC 상한 변경, SIM-C 한파·흐린 주·출력제어 3회', () => {
    const { fromMs, toMs } = window(120);
    const scenarios = presetScenarios('demo120', ALL, { fromMs, toMs });

    expect(scenarios.map((s) => ('site' in s ? `${s.site}:${s.kind}` : s.kind))).toEqual([
      'SIM-A:fault.battery_capacity_fade',
      'SIM-A:fault.inverter_efficiency_drop',
      'SIM-A:fault.cell_imbalance',
      'SIM-B:fault.elz_stack_degradation',
      'SIM-B:fault.fc_voltage_decay',
      'SIM-B:control.soc_upper_limit_change',
      'SIM-C:control.cold_week',
      'SIM-C:control.cloudy_week',
      'SIM-C:control.curtailment',
    ]);
    expect(scenarios[0]).toMatchObject({ asset: 'ESS1/RACK01', startDay: 45, totalPct: 7 });
    expect(scenarios[1]).toMatchObject({ pctPoints: 2, startDay: 60 });
    expect(scenarios[5]).toMatchObject({ day: 90, newLimit: 0.8 });
    expect(() => planScenarios(SIM_SITES, scenarios, { originMs: scenarioOriginMs(fromMs) })).not.toThrow();
  });

  it('세 사이트가 모두 있고 120일 이상이어야 한다', () => {
    expect(() => presetScenarios('demo120', ['SIM-A', 'SIM-B'], window(120))).toThrow('SIM-C');
    expect(() => presetScenarios('demo120', ALL, window(119))).toThrow('120일 이상');
  });
});

describe('EVAL_PRESET · evalRunPlans', () => {
  const allPlans = evalRunPlans();
  const plans = allPlans.filter((p) => p.magnitudes.p3 === null);

  it('시드 × (P2 가장 긴 스윕 길이 + P3 순번)만큼 실행을 만들고, 시드마다 P2 스윕의 모든 크기를 한 번씩 쓴다', () => {
    expect(EVAL_PRESET.days).toBe(365);
    expect(EVAL_PRESET.seeds.length).toBeGreaterThanOrEqual(3);
    expect(allPlans).toHaveLength(EVAL_PRESET.seeds.length * (5 + EVAL_PRESET.p3.runs));
    expect(plans).toHaveLength(EVAL_PRESET.seeds.length * 5);
    expect(allPlans.slice(0, 5).every((p) => p.magnitudes.p3 === null)).toBe(true);
    for (const seed of EVAL_PRESET.seeds) {
      const runs = plans.filter((p) => p.seed === seed);
      expect(runs.map((r) => r.magnitudes.capacityFadePct)).toEqual([1, 3, 5, 7, 10]);
      expect(runs.map((r) => r.magnitudes.integratedCapacityFadePct)).toEqual([1, 3, 5, 7, 10]);
      expect(runs.map((r) => r.magnitudes.cellSpreadMvPerMonth)).toEqual([5, 10, 20, null, null]);
      expect(runs.map((r) => r.scenarios.filter((s) => s.kind === 'dq.stuck_sensor' || s.kind === 'dq.sample_loss').map((s) => ('durationS' in s ? s.durationS / 3_600 : 0)))).toEqual([
        [3, 3, 3, 3],
        [6, 6, 6, 6],
        [12, 12, 12, 12],
        [],
        [],
      ]);
      expect(runs.map((r) => r.magnitudes.elzUvPerH)).toEqual([5, 10, 20, 40, null]);
      expect(runs.map((r) => r.magnitudes.fcUvPerH)).toEqual([5, 10, 20, 40, null]);
      expect(runs.map((r) => r.magnitudes.inverterDropPctPoints)).toEqual([0.5, 1, 2, 3, null]);
    }
    expect(new Set(allPlans.map((p) => p.id)).size).toBe(allPlans.length);
  });

  it('고장은 SIM-A 랙·인버터 1대와 SIM-B 랙 1대·스택에만, 대조군 조건은 SIM-C에만 넣고 모두 검증을 통과한다', () => {
    for (const plan of plans) {
      const faults = plan.scenarios.filter((s) => s.kind.startsWith('fault.'));
      const controls = plan.scenarios.filter((s) => s.kind.startsWith('control.'));
      expect(faults.every((s) => 'site' in s && s.site !== 'SIM-C')).toBe(true);
      expect(faults.every((s) => 'startDay' in s && s.startDay === EVAL_PRESET.faultStartDay)).toBe(true);
      expect(controls).toHaveLength(6);
      expect(controls.every((s) => 'site' in s && s.site === 'SIM-C')).toBe(true);
      expect(() => planScenarios(SIM_SITES, plan.scenarios, { originMs: scenarioOriginMs(plan.from) })).not.toThrow();
    }
    expect(plans.at(-1)?.scenarios.filter((s) => s.kind.startsWith('fault.')).map((s) => ('site' in s ? s.site : ''))).toEqual(['SIM-A', 'SIM-B']);
  });

  it('P3 순번: 스윕 크기를 순번마다 넣고, 헷갈리게 하는 고장(누설·비에너지↔유량계 드리프트, 밸브↔씰, 블로워 마모↔필터)은 같은 순번에 두지 않는다', () => {
    const p3 = allPlans.filter((p) => p.seed === 101 && p.magnitudes.p3 !== null);
    const kindsOf = (plan: (typeof p3)[number]) => plan.scenarios.map((s) => s.kind);

    expect(p3.map((p) => p.id)).toEqual(Array.from({ length: EVAL_PRESET.p3.runs }, (_, i) => `eval-s101-p3-${i + 1}`));
    expect(p3.map((p) => p.magnitudes.p3?.tankLeakKgPerDay ?? null)).toEqual([0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, null, null, null, null, null]);
    expect(p3.map((p) => p.magnitudes.p3?.elzSecRise?.mode ?? null)).toEqual(['rectifier', 'rectifier', 'rectifier', 'faradaic', 'faradaic', 'faradaic', 'stack', 'stack', 'stack', null, null, null]);
    expect(p3.map((p) => p.magnitudes.p3?.flowmeterDriftPctPerMonth ?? null)).toEqual([null, null, null, null, null, null, null, null, null, 1, 2, 4]);
    for (const plan of p3) {
      const kinds = kindsOf(plan);
      expect(kinds.includes('fault.tank_leak') && kinds.includes('fault.flowmeter_drift')).toBe(false);
      expect(kinds.includes('fault.elz_sec_rise') && kinds.includes('fault.flowmeter_drift')).toBe(false);
      expect(kinds.includes('fault.compressor_valve_wear') && kinds.includes('fault.compressor_leak_seal')).toBe(false);
      expect(kinds.includes('fault.fc_blower_wear') && kinds.includes('fault.fc_air_filter_clog')).toBe(false);
      expect(kinds.filter((k) => k === 'fault.elz_sec_rise').length).toBeLessThanOrEqual(1);
      expect(plan.scenarios.filter((s) => s.kind.startsWith('control.')).every((s) => 'site' in s && s.site === 'SIM-C')).toBe(true);
      expect(plan.siteCodes.includes('SIM-A')).toBe(plan.scenarios.some((s) => 'site' in s && s.site === 'SIM-A'));
      expect(() => planScenarios(SIM_SITES, plan.scenarios, { originMs: scenarioOriginMs(plan.from) })).not.toThrow();
    }
    expect(p3.filter((p) => p.siteCodes.includes('SIM-A'))).toHaveLength(4);
  });
});

describe('presetScenarios — demo (demo120 + P3)', () => {
  it('demo120 주입을 모두 유지하고 P3 고장(SIM-A 오염·랙 저항·냉각팬, SIM-B 누설·밸브·비에너지·필터)과 SIM-C 고온 주·일교차 확대를 더한다', () => {
    const { fromMs, toMs } = window(120);
    const demo120 = presetScenarios('demo120', ALL, { fromMs, toMs });
    const demo = presetScenarios('demo', ALL, { fromMs, toMs });

    expect(demo.slice(0, demo120.length)).toEqual(demo120);
    expect(demo.slice(demo120.length).map((s) => ('site' in s ? `${s.site}:${s.kind}` : s.kind))).toEqual([
      'SIM-A:fault.pv_soiling',
      'SIM-A:fault.rack_resistance_growth',
      'SIM-A:fault.inverter_fan_failure',
      'SIM-B:fault.tank_leak',
      'SIM-B:fault.compressor_valve_wear',
      'SIM-B:fault.elz_sec_rise',
      'SIM-B:fault.fc_air_filter_clog',
      'SIM-C:control.hot_week',
      'SIM-C:control.day_night_swing',
    ]);
    expect(demo.find((s) => s.kind === 'fault.tank_leak')).toMatchObject({ kgPerDay: 0.05, startDay: 60, escalations: [{ day: 90, kgPerDay: 2 * DEMO_TANK_LEAK_SAFETY_KG_PER_DAY }] });
    expect(demo.find((s) => s.kind === 'fault.fc_air_filter_clog')).toMatchObject({ pct: 35, startDay: 70, cleanedDay: 110 });
    expect(demo.find((s) => s.kind === 'fault.pv_soiling')).toMatchObject({ rainDays: [45, 75] });
    expect(() => planScenarios(SIM_SITES, demo, { originMs: scenarioOriginMs(fromMs) })).not.toThrow();
    expect(SCENARIO_PRESETS).toContain('demo');
    expect(() => presetScenarios('demo', ['SIM-A', 'SIM-B'], window(120))).toThrow('SIM-C');
    expect(() => presetScenarios('demo', ALL, window(119))).toThrow('120일 이상');
  });
});
