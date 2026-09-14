import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { CONTROL_SETTINGS, controlsAt, socMaxAt, weatherWindowsOf } from './control-scenarios';
import { EMS_SETTINGS } from './ems';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { planScenarios, type Scenario } from './scenarios';

const ORIGIN = Date.parse('2026-05-01T00:00:00+09:00');
const day = (n: number, hour = 0) => ORIGIN + n * MS_PER_DAY + hour * MS_PER_HOUR;
const planOf = (code: string, scenarios: readonly Scenario[]) => {
  const plan = planScenarios(SIM_SITES, scenarios, { originMs: ORIGIN }).get(code);
  if (!plan) throw new Error(code);
  return plan;
};

describe('applyControl (planScenarios)', () => {
  it('주간 조건은 startDay 0시부터 7일 구간이다 (대조군 사이트 SIM-C에도 넣을 수 있다)', () => {
    const plan = planOf('SIM-C', [
      { kind: 'control.cold_week', site: 'SIM-C', startDay: 20 },
      { kind: 'control.cloudy_week', site: 'SIM-C', startDay: 50 },
      { kind: 'control.elz_part_load_week', site: 'SIM-C', startDay: 3 },
      { kind: 'control.fc_frequent_start_stop', site: 'SIM-C', startDay: 4 },
    ]);

    expect(plan.coldWeeks).toEqual([{ startMs: day(20), endMs: day(27), ambientDeltaC: -10, roomDeltaC: -4 }]);
    expect(plan.cloudyWeeks).toEqual([{ startMs: day(50), endMs: day(57), cloudMin: 0.85 }]);
    expect(plan.elzPartLoads).toEqual([{ startMs: day(3), endMs: day(10), maxLoadFraction: 0.4 }]);
    expect(plan.fcStartStops).toEqual([{ startMs: day(4), endMs: day(11) }]);
  });

  it('control.curtailment: count회, 7일 간격, KST 11~15시 출력 제한 0%', () => {
    const plan = planOf('SIM-C', [{ kind: 'control.curtailment', site: 'SIM-C', startDay: 70, count: 3 }]);

    expect(plan.curtailments).toEqual([70, 77, 84].map((n) => ({ startMs: day(n, 11), endMs: day(n, 15), limitPct: 0 })));
  });

  it('control.soc_upper_limit_change: 시각 순으로 쌓고 그 시각부터 상한이 바뀐다', () => {
    const plan = planOf('SIM-B', [
      { kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 90, newLimit: 0.8 },
      { kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 10, newLimit: 0.95 },
    ]);

    expect(plan.socLimitChanges.map((c) => c.newLimit)).toEqual([0.95, 0.8]);
    expect([day(10) - 1, day(10), day(90) - 1, day(90)].map((t) => socMaxAt(plan, t))).toEqual([EMS_SETTINGS.socMax, 0.95, 0.95, 0.8]);
  });

  it.each([
    [{ kind: 'control.cold_week', site: 'SIM-C', startDay: 1.5 }, '정수'],
    [{ kind: 'control.curtailment', site: 'SIM-C', startDay: 1, count: 0 }, 'count'],
    [{ kind: 'control.elz_part_load_week', site: 'SIM-A', startDay: 1 }, 'h2.elz'],
    [{ kind: 'control.fc_frequent_start_stop', site: 'SIM-A', startDay: 1 }, 'fc.plant'],
    [{ kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1/RACK01', day: 1, newLimit: 0.8 }, 'ess.plant 설비 ESS1/RACK01'],
    [{ kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 1, newLimit: 0.3 }, 'newLimit'],
  ] as const)('잘못된 대조군 시나리오는 거부한다: %o', (scenario, message) => {
    expect(() => planScenarios(SIM_SITES, [scenario], { originMs: ORIGIN })).toThrow(message);
  });

  it('실행 기준일이 없으면 거부한다', () => {
    expect(() => planScenarios(SIM_SITES, [{ kind: 'control.cloudy_week', site: 'SIM-C', startDay: 1 }])).toThrow('실행 기준일');
  });
});

describe('controlsAt · weatherWindowsOf', () => {
  const plan = planOf('SIM-B', [
    { kind: 'control.cold_week', site: 'SIM-B', startDay: 1 },
    { kind: 'control.curtailment', site: 'SIM-B', startDay: 2, count: 1 },
    { kind: 'control.elz_part_load_week', site: 'SIM-B', startDay: 1 },
    { kind: 'control.fc_frequent_start_stop', site: 'SIM-B', startDay: 3 },
    { kind: 'control.soc_upper_limit_change', site: 'SIM-B', asset: 'ESS1', day: 2, newLimit: 0.8 },
  ]);

  it('구간 밖은 조건 없음과 같다', () => {
    expect(controlsAt(plan, day(0, 12))).toEqual({ pvLimitPct: 100, socMax: EMS_SETTINGS.socMax, elzLoadCap: 1, fcCycling: false, roomDeltaC: 0 });
  });

  it('구간 안에서는 출력 제한·SOC 상한·전해조 상한·연료전지 일정·배터리실 편차(양끝 12시간 램프)를 돌려준다', () => {
    expect(controlsAt(plan, day(2, 12))).toEqual({ pvLimitPct: 0, socMax: 0.8, elzLoadCap: 0.4, fcCycling: false, roomDeltaC: -4 });
    expect(controlsAt(plan, day(3, 15))).toMatchObject({ pvLimitPct: 100, fcCycling: true });
    expect(controlsAt(plan, day(1, 6)).roomDeltaC).toBeCloseTo(-2, 12);
  });

  it('한파는 기온 편차(램프), 흐린 주는 운량 하한으로 기상에 넘긴다', () => {
    const windows = weatherWindowsOf(planOf('SIM-C', [
      { kind: 'control.cold_week', site: 'SIM-C', startDay: 1 },
      { kind: 'control.cloudy_week', site: 'SIM-C', startDay: 9 },
    ]));

    expect(windows).toEqual([
      { startMs: day(1), endMs: day(8), ambientDeltaC: -10, cloudMin: 0, rampMs: CONTROL_SETTINGS.coldWeek.rampMs },
      { startMs: day(9), endMs: day(16), ambientDeltaC: 0, cloudMin: 0.85, rampMs: 0 },
    ]);
  });
});
