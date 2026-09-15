import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { P3_CONTROL_SETTINGS, p3ControlsAt, p3WeatherWindows } from './control-scenarios-p3';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { planScenarios, type Scenario } from './scenarios';

const ORIGIN = Date.parse('2026-05-01T00:00:00+09:00');
const day = (n: number, hour = 0) => ORIGIN + n * MS_PER_DAY + hour * MS_PER_HOUR;
const planOf = (code: string, scenarios: readonly Scenario[]) => {
  const plan = planScenarios(SIM_SITES, scenarios, { originMs: ORIGIN }).get(code);
  if (!plan) throw new Error(code);
  return plan;
};

describe('applyP3Control (planScenarios)', () => {
  const plan = planOf('SIM-C', [
    { kind: 'control.hot_week', site: 'SIM-C', startDay: 10 },
    { kind: 'control.rainy_week', site: 'SIM-C', startDay: 20 },
    { kind: 'control.day_night_swing', site: 'SIM-C', startDay: 30 },
    { kind: 'control.tank_refill_topoff', site: 'SIM-C', startDay: 40 },
    { kind: 'control.compressor_high_ratio_week', site: 'SIM-C', startDay: 50 },
    { kind: 'control.healthy_mass_balance', site: 'SIM-C', startDay: 60, days: 30 },
  ]);

  it('주간 조건은 startDay 0시부터 7일, 비 오는 주는 매일 04~12시 강한 비, 보유 중 충전은 매일 02시부터 60분', () => {
    expect(plan.hotWeeks).toEqual([{ startMs: day(10), endMs: day(17), ambientDeltaC: 8 }]);
    expect(plan.rainyWeeks).toEqual([{ startMs: day(20), endMs: day(27) }]);
    expect(plan.rainWindows).toEqual(Array.from({ length: 7 }, (_, i) => ({ startMs: day(20 + i, 4), endMs: day(20 + i, 12) })));
    expect(plan.tankSwings).toEqual([{ startMs: day(30), endMs: day(37), amplitudeC: P3_CONTROL_SETTINGS.dayNightSwing.amplitudeC }]);
    expect(plan.topoffs).toEqual(Array.from({ length: 7 }, (_, i) => ({ startMs: day(40 + i, 2), endMs: day(40 + i, 3) })));
    expect(plan.highRatioWeeks).toEqual([{ startMs: day(50), endMs: day(57), suctionBar: 15 }]);
    expect(plan.healthyBalances).toEqual([{ startMs: day(60), endMs: day(90) }]);
  });

  it('구간 밖은 조건 없음, 안에서는 일교차 편차(14시 최고)·흡입 압력·보유 중 충전을 돌려준다', () => {
    expect(p3ControlsAt(plan, day(0, 12))).toEqual({ tankSwingC: 0, suctionBar: null, elzTopoff: false, pvCleaning: false });
    expect(p3ControlsAt(plan, day(33, 14)).tankSwingC).toBeCloseTo(P3_CONTROL_SETTINGS.dayNightSwing.amplitudeC, 9);
    expect(p3ControlsAt(plan, day(33, 2)).tankSwingC).toBeCloseTo(-P3_CONTROL_SETTINGS.dayNightSwing.amplitudeC, 9);
    expect(p3ControlsAt(plan, day(30, 6)).tankSwingC).toBeCloseTo(P3_CONTROL_SETTINGS.dayNightSwing.amplitudeC * Math.cos((2 * Math.PI * -8) / 24) * 0.5, 9);
    expect(p3ControlsAt(plan, day(52, 9))).toMatchObject({ suctionBar: 15 });
    expect([day(41, 2) - 1, day(41, 2) + 30 * MS_PER_MINUTE, day(41, 3)].map((t) => p3ControlsAt(plan, t).elzTopoff)).toEqual([false, true, false]);
  });

  it('합성 기상에는 고온 주(기온 램프)·비 오는 주(운량 하한)·강한 비를 넘긴다', () => {
    const windows = p3WeatherWindows(plan);

    expect(windows[0]).toEqual({ startMs: day(10), endMs: day(17), ambientDeltaC: 8, cloudMin: 0, rampMs: P3_CONTROL_SETTINGS.hotWeek.rampMs });
    expect(windows[1]).toEqual({ startMs: day(20), endMs: day(27), ambientDeltaC: 0, cloudMin: 0.8, rampMs: 0 });
    expect(windows.slice(2)).toEqual(plan.rainWindows.map((w) => ({ ...w, ambientDeltaC: 0, cloudMin: 0, rampMs: 0, rain: true })));
  });

  it('모듈 세척은 세척 시각부터 5분 동안 켜진다', () => {
    const cleaning = planOf('SIM-A', [{ kind: 'fault.pv_soiling', site: 'SIM-A', pctPerDay: 0.1, cleaningDay: 3 }]);

    expect([day(3, 10) - 1, day(3, 10), day(3, 10) + 4 * MS_PER_MINUTE, day(3, 10) + 5 * MS_PER_MINUTE].map((t) => p3ControlsAt(cleaning, t).pvCleaning)).toEqual([false, true, true, false]);
  });

  it.each([
    [{ kind: 'control.day_night_swing', site: 'SIM-A', startDay: 1 }, 'h2.storage.tank'],
    [{ kind: 'control.tank_refill_topoff', site: 'SIM-A', startDay: 1 }, 'h2.elz'],
    [{ kind: 'control.compressor_high_ratio_week', site: 'SIM-A', startDay: 1 }, 'h2.compressor'],
    [{ kind: 'control.healthy_mass_balance', site: 'SIM-C', startDay: 1, days: 3 }, 'days'],
    [{ kind: 'control.hot_week', site: 'SIM-C', startDay: 0.5 }, '정수'],
  ] as const)('잘못된 P3 대조군 시나리오는 거부한다: %o', (scenario, message) => {
    expect(() => planScenarios(SIM_SITES, [scenario], { originMs: ORIGIN })).toThrow(message);
  });
});
