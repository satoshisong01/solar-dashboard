import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { kstHourOfDay, MS_PER_DAY, MS_PER_HOUR } from './math';
import { EVAL_PRESET, evalRunPlans, presetScenarios } from './presets';
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
  const plans = evalRunPlans();

  it('시드 × 가장 긴 스윕 길이만큼 실행을 만들고, 시드마다 스윕의 모든 크기를 한 번씩 쓴다', () => {
    expect(EVAL_PRESET.days).toBe(365);
    expect(plans).toHaveLength(EVAL_PRESET.seeds.length * 5);
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
    expect(new Set(plans.map((p) => p.id)).size).toBe(plans.length);
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
});
