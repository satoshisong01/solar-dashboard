import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { kstHourOfDay, MS_PER_DAY, MS_PER_HOUR } from './math';
import { presetScenarios } from './presets';
import { planScenarios, type Scenario } from './scenarios';

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
