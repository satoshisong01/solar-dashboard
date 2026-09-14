import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { createDegradationResolver, DEGRADATION_PARAMS, planScenarios, type FaultScenario } from './scenarios';

const T0 = Date.parse('2026-09-01T00:00:00+09:00');

describe('planScenarios', () => {
  it('사이트별로 단절 창·시계 오차·중복 비율·고착·스파이크·경보를 모은다', () => {
    const plans = planScenarios(SIM_SITES, [
      { kind: 'healthy' },
      { kind: 'dq.gateway_outage', site: 'SIM-A', start: T0, durationS: 6 * 3_600 },
      { kind: 'dq.clock_skew', site: 'SIM-B', skewS: 200 },
      { kind: 'dq.duplicate_batches', site: 'SIM-B', ratio: 0.05 },
      { kind: 'dq.stuck_sensor', site: 'SIM-B', sourceKey: 'WX1/T_AMB', start: '2026-09-01T03:00:00Z', durationS: 3_600 },
      { kind: 'dq.spike', site: 'SIM-C', sourceKey: 'ELZ1/DRYER/PURITY', perDay: 2 },
      { kind: 'safety.h2_leak_alarm', site: 'SIM-B', at: new Date(T0) },
    ]);

    expect(plans.get('SIM-A')?.outages).toEqual([{ startMs: T0, endMs: T0 + 6 * 3_600_000 }]);
    expect(plans.get('SIM-B')).toMatchObject({
      clockSkewMs: 200_000,
      duplicateRatio: 0.05,
      stuckSensors: [{ sourceKey: 'WX1/T_AMB', startMs: Date.parse('2026-09-01T03:00:00Z') }],
      leakAlarms: [{ atMs: T0, detector: 'GD3' }], // 기본: 저장뱅크 위치 검지기
    });
    expect(plans.get('SIM-C')?.spikes).toEqual([{ sourceKey: 'ELZ1/DRYER/PURITY', perDay: 2, magnitude: 3 }]);
  });

  it('미매핑 예정 태그도 센서 시나리오 대상으로 받는다', () => {
    const plans = planScenarios(SIM_SITES, [{ kind: 'dq.stuck_sensor', site: 'SIM-B', sourceKey: 'COMP1/VIB_RMS', start: T0, durationS: 60 }]);

    expect(plans.get('SIM-B')?.stuckSensors).toHaveLength(1);
  });

  it.each([
    [{ kind: 'dq.clock_skew', site: 'SIM-X', skewS: 1 }, '시뮬레이션 대상이 아닌'],
    [{ kind: 'dq.spike', site: 'SIM-A', sourceKey: 'NOPE/TAG', perDay: 1 }, '없는 원본 태그'],
    [{ kind: 'dq.duplicate_batches', site: 'SIM-A', ratio: 1.5 }, 'ratio'],
    [{ kind: 'dq.gateway_outage', site: 'SIM-A', start: T0, durationS: 0 }, '0보다 커야'],
    [{ kind: 'dq.gateway_outage', site: 'SIM-A', start: 'not-a-date', durationS: 10 }, '해석할 수 없습니다'],
    [{ kind: 'safety.h2_leak_alarm', site: 'SIM-A', at: T0 }, '수소 검지기'],
  ] as const)('잘못된 시나리오는 거부한다: %o', (scenario, message) => {
    expect(() => planScenarios(SIM_SITES, [scenario])).toThrow(message);
  });

  it('고장 주입: 대조군(SIM-C)·해당 설비가 없는 사이트는 거부한다', () => {
    const fault = (site: string, param: FaultScenario['param'], asset?: string): FaultScenario => ({ kind: 'fault', site, param, asset, value: () => 0.01 });

    expect(() => planScenarios(SIM_SITES, [fault('SIM-C', 'battery.capacityFadePerDay')])).toThrow('대조군');
    expect(() => planScenarios(SIM_SITES, [fault('SIM-A', 'elz.degradationUvPerH')])).toThrow('h2.elz.stack');
    expect(() => planScenarios(SIM_SITES, [fault('SIM-B', 'battery.cellImbalance', 'ESS1/RACK09')])).toThrow('ESS1/RACK09');
    expect(planScenarios(SIM_SITES, [fault('SIM-B', 'battery.cellImbalance', 'ESS1/RACK02')]).get('SIM-B')?.faults).toHaveLength(1);
  });
});

describe('createDegradationResolver', () => {
  it('설비 지정 hook > 사이트 전체 hook > 기본값 순서로 적용하고 시각을 넘긴다', () => {
    const resolver = createDegradationResolver([
      { kind: 'fault', site: 'SIM-B', param: 'battery.capacityFadePerDay', value: (_t, base) => base * 2 },
      { kind: 'fault', site: 'SIM-B', param: 'battery.capacityFadePerDay', asset: 'ESS1/RACK01', value: (t) => (t >= T0 ? 0.001 : 0) },
    ]);
    const baseline = DEGRADATION_PARAMS['battery.capacityFadePerDay'].baseline;

    expect(resolver.value('battery.capacityFadePerDay', 'ESS1/RACK01', T0)).toBe(0.001);
    expect(resolver.value('battery.capacityFadePerDay', 'ESS1/RACK01', T0 - 1)).toBe(0);
    expect(resolver.value('battery.capacityFadePerDay', 'ESS1/RACK02', T0)).toBe(baseline * 2);
    expect(resolver.value('elz.degradationUvPerH', 'ELZ1/STACK1', T0)).toBe(DEGRADATION_PARAMS['elz.degradationUvPerH'].baseline);
  });

  it('hook이 음수·NaN을 돌려주면 오류', () => {
    const resolver = createDegradationResolver([{ kind: 'fault', site: 'SIM-B', param: 'blower.wear', value: () => Number.NaN }]);

    expect(() => resolver.value('blower.wear', 'FC1/BLOWER1', T0)).toThrow('잘못된 값');
  });
});
