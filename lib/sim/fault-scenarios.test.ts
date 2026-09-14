import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { createDegradationResolver, DEGRADATION_PARAMS } from './degradation';
import { DAYS_PER_MONTH, resolveFault } from './fault-scenarios';
import { kstDateToMs, MS_PER_DAY } from './math';
import { planScenarios, scenarioOriginMs } from './scenarios';

const ORIGIN = Date.parse('2026-05-01T00:00:00+09:00');

function site(code: string): SiteDef {
  const found = SIM_SITES.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found;
}

describe('resolveFault', () => {
  it('fault.battery_capacity_fade: 시작 시점 SOH 대비 totalPct%를 days일에 나눠 기본 감소율에 더한다', () => {
    const resolved = resolveFault(site('SIM-A'), { kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK02', startDay: 45, totalPct: 7, days: 30 }, ORIGIN);
    const startMs = ORIGIN + 45 * MS_PER_DAY;
    const baseline = DEGRADATION_PARAMS['battery.capacityFadePerDay'].baseline;
    const sohAtStart = 1 - (baseline * (startMs - kstDateToMs('2025-03-01'))) / MS_PER_DAY;
    const { value } = resolved.hook;

    expect(resolved).toMatchObject({ assetCode: 'ESS1/RACK02', startMs, fullEffectMs: startMs + 30 * MS_PER_DAY, params: { totalPct: 7, days: 30 } });
    expect(resolved.hook).toMatchObject({ kind: 'fault', site: 'SIM-A', param: 'battery.capacityFadePerDay', asset: 'ESS1/RACK02' });
    expect(value(startMs - 1, baseline)).toBe(baseline);
    expect((value(startMs, baseline) - baseline) * 30).toBeCloseTo(sohAtStart * 0.07, 12);
    expect(value(startMs + 30 * MS_PER_DAY, baseline)).toBe(baseline);
  });

  it('fault.cell_imbalance: 셀 전압 산포 추가분이 한 달에 mVPerMonth씩 커진다', () => {
    const resolved = resolveFault(site('SIM-A'), { kind: 'fault.cell_imbalance', site: 'SIM-A', asset: 'ESS1/RACK03', mVPerMonth: 10, startDay: 30 }, ORIGIN);
    const startMs = ORIGIN + 30 * MS_PER_DAY;

    expect(resolved.hook).toMatchObject({ param: 'battery.cellSpreadMv', asset: 'ESS1/RACK03' });
    expect(resolved.hook.value(startMs, 0)).toBe(0);
    expect(resolved.hook.value(startMs + DAYS_PER_MONTH * 3 * MS_PER_DAY, 0)).toBeCloseTo(30, 9);
  });

  it('fault.inverter_efficiency_drop: 기본은 시작일 계단, rampDays를 주면 선형으로 떨어진다', () => {
    const step = resolveFault(site('SIM-A'), { kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV01', pctPoints: 2, startDay: 60 }, ORIGIN);
    const ramp = resolveFault(site('SIM-A'), { kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV02', pctPoints: 2, startDay: 60, rampDays: 10 }, ORIGIN);
    const startMs = ORIGIN + 60 * MS_PER_DAY;

    expect([step.hook.value(startMs - 1, 0), step.hook.value(startMs, 0)]).toEqual([0, 0.02]);
    expect(ramp.hook.value(startMs + 5 * MS_PER_DAY, 0)).toBeCloseTo(0.01, 12);
    expect(ramp.fullEffectMs).toBe(startMs + 10 * MS_PER_DAY);
  });

  it('fault.elz_stack_degradation · fault.fc_voltage_decay: 사이트의 스택을 찾아 시작일부터 율을 바꾼다', () => {
    const elz = resolveFault(site('SIM-B'), { kind: 'fault.elz_stack_degradation', site: 'SIM-B', uvPerH: 25 }, ORIGIN);
    const fc = resolveFault(site('SIM-B'), { kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: 30, startDay: 3 }, ORIGIN);

    expect(elz).toMatchObject({ assetCode: 'ELZ1/STACK1', startMs: ORIGIN, params: { uvPerH: 25, baselineUvPerH: 4 } });
    expect(elz.hook.value(ORIGIN, 4)).toBe(25);
    expect(fc).toMatchObject({ assetCode: 'FC1/STACK1', startMs: ORIGIN + 3 * MS_PER_DAY, params: { uvPerH: 30, baselineUvPerH: 6 } });
    expect([fc.hook.value(ORIGIN, 6), fc.hook.value(ORIGIN + 3 * MS_PER_DAY, 6)]).toEqual([6, 30]);
  });

  it.each([
    [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'PV1/INV01', startDay: 1, totalPct: 5, days: 30 }, 'ess.rack 설비 PV1/INV01'],
    [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay: 1, totalPct: 0, days: 30 }, 'totalPct'],
    [{ kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay: -1, totalPct: 5, days: 30 }, 'startDay'],
    [{ kind: 'fault.cell_imbalance', site: 'SIM-A', asset: 'ESS1/RACK01', mVPerMonth: Number.NaN }, 'mVPerMonth'],
    [{ kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV09', pctPoints: 1 }, 'PV1/INV09'],
    [{ kind: 'fault.elz_stack_degradation', site: 'SIM-A', uvPerH: 10 }, 'h2.elz.stack'],
  ] as const)('잘못된 고장 시나리오는 거부한다: %o', (fault, message) => {
    expect(() => resolveFault(site(fault.site), fault, ORIGIN)).toThrow(message);
  });
});

describe('planScenarios — 고장 시나리오', () => {
  it('실행 기준일이 있어야 하고, 대조군 사이트에는 넣을 수 없다', () => {
    const fault = { kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: 30 } as const;

    expect(() => planScenarios(SIM_SITES, [fault])).toThrow('실행 기준일');
    expect(() => planScenarios(SIM_SITES, [{ ...fault, site: 'SIM-C' }], { originMs: ORIGIN })).toThrow('대조군');
  });

  it('계획의 hook을 열화 파라미터 조회기가 설비 단위로 돌려준다', () => {
    const plan = planScenarios(SIM_SITES, [{ kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV03', pctPoints: 1.5, startDay: 2 }], { originMs: ORIGIN }).get('SIM-A');
    const resolver = createDegradationResolver(plan?.faults ?? []);
    const at = ORIGIN + 2 * MS_PER_DAY;

    expect(resolver.value('inverter.efficiencyDrop', 'PV1/INV03', at)).toBe(0.015);
    expect(resolver.value('inverter.efficiencyDrop', 'PV1/INV03', at - 1)).toBe(0);
    expect(resolver.value('inverter.efficiencyDrop', 'PV1/INV01', at)).toBe(0);
  });

  it('scenarioOriginMs: 실행 시작 시각이 속한 KST 날짜 0시', () => {
    expect(scenarioOriginMs('2026-05-01T23:30:00+09:00')).toBe(ORIGIN);
    expect(scenarioOriginMs('2026-04-30T15:00:00Z')).toBe(ORIGIN);
  });
});
