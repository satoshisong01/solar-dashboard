import { describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { createDegradationResolver } from './degradation';
import { DAYS_PER_MONTH } from './fault-scenarios';
import { resolveP3Fault, type ElzSecRiseMode, type P3FaultScenario } from './fault-scenarios-p3';
import { MS_PER_DAY, MS_PER_HOUR } from './math';
import { faradayEfficiency, NO_ELZ_FAULTS, operatingPoint } from './models/electrolyzer';
import { DRYER_LOSS_FRACTION } from './plant-hydrogen';
import { planScenarios } from './scenarios';
import { electrolyzerParamsOf } from './site-params';

const ORIGIN = Date.parse('2026-05-01T00:00:00+09:00');
const day = (n: number, hour = 0) => ORIGIN + n * MS_PER_DAY + hour * MS_PER_HOUR;

function site(code: string): SiteDef {
  const found = SIM_SITES.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found;
}

const resolve = (fault: P3FaultScenario) => resolveP3Fault(site(fault.site), fault, ORIGIN);
const hookAt = (fault: P3FaultScenario, tMs: number, baseline = 0) => resolve(fault).hooks[0]?.value(tMs, baseline) ?? Number.NaN;

describe('resolveP3Fault — 저장·유량계', () => {
  it('fault.tank_leak: 시작일부터 kgPerDay, escalations 날부터 그 크기 (계단). 대상 용기 hook 하나', () => {
    const fault: P3FaultScenario = { kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1/TANK3', kgPerDay: 0.05, startDay: 60, escalations: [{ day: 90, kgPerDay: 1 }] };
    const resolved = resolve(fault);

    expect(resolved.hooks[0]).toMatchObject({ param: 'storage.leakKgPerDay', asset: 'H2BANK1/TANK3' });
    expect([hookAt(fault, day(60) - 1), hookAt(fault, day(60)), hookAt(fault, day(90) - 1), hookAt(fault, day(90))]).toEqual([0, 0.05, 0.05, 1]);
    expect(resolved).toMatchObject({ assetCodes: ['H2BANK1/TANK3'], startMs: day(60), fullEffectMs: day(90), recoveredMs: null, params: { kgPerDay: 0.05, maxKgPerDay: 1 } });
  });

  it('fault.flowmeter_drift: 유량계 이득이 한 달에 pctPerMonth%씩 커진다 (음수면 과소 계량)', () => {
    const up: P3FaultScenario = { kind: 'fault.flowmeter_drift', site: 'SIM-B', pctPerMonth: 2, startDay: 10 };
    const down: P3FaultScenario = { ...up, pctPerMonth: -3 };

    expect(hookAt(up, day(10) - 1, 1)).toBe(1);
    expect(hookAt(up, day(10) + DAYS_PER_MONTH * MS_PER_DAY, 1)).toBeCloseTo(1.02, 12);
    expect(hookAt(down, day(10) + 2 * DAYS_PER_MONTH * MS_PER_DAY, 1)).toBeCloseTo(0.94, 12);
    expect(resolve(up).assetCodes).toEqual(['ELZ1']);
  });
});

describe('resolveP3Fault — 전해조 비에너지 경로 보정', () => {
  const sim = site('SIM-B');
  const params = electrolyzerParamsOf(sim);
  /** 정격 전류·60 °C에서 설비 AC [kW] ÷ 수소 [kg/h] (고장 크기를 hook에서 꺼내 모델에 넣는다). 퍼지 경로는 건조기 뒤라 여기 안 보인다 */
  const secAt = (mode: 'rectifier' | 'faradaic' | 'stack' | null, pct: number): number => {
    const faults = { ...NO_ELZ_FAULTS };
    if (mode !== null) {
      const resolved = resolveP3Fault(sim, { kind: 'fault.elz_sec_rise', site: 'SIM-B', mode, pct, startDay: 0, rampDays: 0 }, ORIGIN);
      const magnitude = resolved.hooks[0]?.value(ORIGIN, 0) ?? 0;
      const key = { rectifier: 'rectifierLossExtra', faradaic: 'faradaicLoss', stack: 'extraCellVoltageV' }[mode] as keyof typeof faults;
      Object.assign(faults, { [key]: magnitude });
    }
    const point = operatingPoint(params, params.ratedCurrentA, 60, 0, faults);
    const etaF = faradayEfficiency(params, point.currentDensityAcm2, faults.faradaicLoss);
    return point.totalAcKw / (params.cellCount * params.ratedCurrentA * etaF);
  };

  it.each(['rectifier', 'faradaic', 'stack'] as const)('%s 경로 6%: 기준점 비에너지가 정확히 6% 오른다', (mode) => {
    expect(secAt(mode, 6) / secAt(null, 0)).toBeCloseTo(1.06, 9);
  });

  it('purge 경로 6%: 건조기 재생 손실률이 퍼지 빈도와 같은 배율로 커져 제품 수소 기준 비에너지가 6% 오른다', () => {
    const resolved = resolve({ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'purge', pct: 6, startDay: 0, rampDays: 0 });
    const extra = resolved.hooks[0]?.value(ORIGIN, 0) ?? 0;
    const lossAfter = DRYER_LOSS_FRACTION * (1 + extra);

    expect(resolved.hooks[0]).toMatchObject({ param: 'elz.purgeRateExtra', asset: 'ELZ1/DRYER' });
    expect((1 - DRYER_LOSS_FRACTION) / (1 - lossAfter)).toBeCloseTo(1.06, 12);
    expect(lossAfter).toBeCloseTo(0.0849, 4); // 3% → 8.5%: 퍼지 빈도 약 2.8배
    expect(extra).toBeCloseTo(1.8302, 4);
  });

  it('purge 경로는 15%까지만 받는다 (그 위는 건조기 재생 손실률이 현실 범위를 벗어난다)', () => {
    expect(() => resolve({ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'purge', pct: 20, startDay: 0 })).toThrow('pct');
    expect(() => resolve({ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'stack', pct: 20, startDay: 0 })).not.toThrow();
  });

  it('경로마다 다른 설비 hook·크기: 정류기(RECT1 추가 손실), 패러데이(스택 손실률), 셀 전압(스택 V, 6%면 약 0.1 V)', () => {
    const of = (mode: ElzSecRiseMode) => resolve({ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode, pct: 6, startDay: 5, rampDays: 10 });

    expect(of('rectifier').hooks[0]).toMatchObject({ param: 'elz.rectifierLossExtra', asset: 'ELZ1/RECT1' });
    expect(of('faradaic').hooks[0]).toMatchObject({ param: 'elz.faradaicLoss', asset: 'ELZ1/STACK1' });
    expect(of('stack').hooks[0]).toMatchObject({ param: 'elz.extraCellVoltageV', asset: 'ELZ1/STACK1' });
    expect(of('faradaic').hooks[0]?.value(day(10), 0)).toBeCloseTo(0.5 * (0.06 / 1.06), 12);
    expect(of('stack').params.extraCellVoltageMv).toBeGreaterThan(80);
    expect(of('stack').params.extraCellVoltageMv).toBeLessThan(150);
    expect(of('rectifier')).toMatchObject({ assetCodes: ['ELZ1'], startMs: day(5), fullEffectMs: day(15) });
  });
});

describe('resolveP3Fault — 압축기·블로워·필터', () => {
  it('fault.compressor_valve_wear·rack_resistance_growth: 기본 60일 램프로 pct%까지', () => {
    const valve: P3FaultScenario = { kind: 'fault.compressor_valve_wear', site: 'SIM-B', pct: 12, startDay: 40 };
    const rack: P3FaultScenario = { kind: 'fault.rack_resistance_growth', site: 'SIM-A', rack: 'ESS1/RACK02', pct: 45, startDay: 50, rampDays: 60 };

    expect(hookAt(valve, day(70))).toBeCloseTo(0.06, 12);
    expect(hookAt(valve, day(200))).toBeCloseTo(0.12, 12);
    expect(resolve(rack).hooks[0]).toMatchObject({ param: 'battery.resistanceGrowth', asset: 'ESS1/RACK02' });
    expect(hookAt(rack, day(110))).toBeCloseTo(0.45, 12);
  });

  it('fault.compressor_leak_seal: 누설 감지 압력 상승분이 하루 rate bar씩, 상한 50 bar', () => {
    const seal: P3FaultScenario = { kind: 'fault.compressor_leak_seal', site: 'SIM-B', rate: 0.5, startDay: 1 };

    expect(hookAt(seal, day(11))).toBeCloseTo(5, 12);
    expect(hookAt(seal, day(400))).toBe(50);
  });

  it('fault.fc_blower_wear: 전력 배율 1/(1 − 마모) = 1 + 월 증가율 × 개월', () => {
    const wear = hookAt({ kind: 'fault.fc_blower_wear', site: 'SIM-B', pctPerMonth: 5, startDay: 0 }, ORIGIN + 3 * DAYS_PER_MONTH * MS_PER_DAY);

    expect(1 / (1 - wear)).toBeCloseTo(1.15, 12);
  });

  it('fault.fc_air_filter_clog: 램프 뒤 cleanedDay 10시 필터 교체로 0, 교체 이벤트와 회복 시각을 돌려준다', () => {
    const fault: P3FaultScenario = { kind: 'fault.fc_air_filter_clog', site: 'SIM-B', pct: 25, startDay: 40, rampDays: 45, cleanedDay: 100 };
    const resolved = resolve(fault);

    expect(hookAt(fault, day(85))).toBeCloseTo(0.25, 12);
    expect(hookAt(fault, day(100, 10) - 1)).toBeCloseTo(0.25, 12);
    expect(hookAt(fault, day(100, 10))).toBe(0);
    expect(resolved.events.filterReplacements).toEqual([{ atMs: day(100, 10), assetCode: 'FC1/BLOWER1' }]);
    expect(resolved.recoveredMs).toBe(day(100, 10));
  });
});

describe('resolveP3Fault — 태양광·인버터', () => {
  it('fault.pv_soiling: 사이트 전 인버터 hook 하나, 강우일 03~09시 강한 비 구간, 세척 10시 이벤트, 정답 행은 인버터마다', () => {
    const resolved = resolve({ kind: 'fault.pv_soiling', site: 'SIM-A', pctPerDay: 0.08, startDay: 0, rainDays: [85, 45], cleaningDay: 100 });

    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.hooks[0]).toMatchObject({ param: 'pv.stickySoilingPerDay' });
    expect(resolved.hooks[0]?.asset).toBeUndefined();
    expect(resolved.hooks[0]?.value(ORIGIN, 0)).toBeCloseTo(0.0008, 12);
    expect(resolved.events.rainWindows).toEqual([45, 85].map((d) => ({ startMs: day(d, 3), endMs: day(d, 9) })));
    expect(resolved.events.pvCleanings).toEqual([{ atMs: day(100, 10), assetCode: 'PV1' }]);
    expect(resolved.assetCodes).toEqual(['PV1/INV01', 'PV1/INV02', 'PV1/INV03', 'PV1/INV04']);
  });

  it('fault.inverter_fan_failure: 시작일부터 냉각 성능 저하 1 (방열판 온도 상승폭 2배)', () => {
    const fault: P3FaultScenario = { kind: 'fault.inverter_fan_failure', site: 'SIM-A', inverter: 'PV1/INV02', startDay: 40 };

    expect([hookAt(fault, day(40) - 1), hookAt(fault, day(40))]).toEqual([0, 1]);
  });

  it.each([
    [{ kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1', kgPerDay: 0.1, startDay: 1 }, 'h2.storage.tank'],
    [{ kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1/TANK1', kgPerDay: 0, startDay: 1 }, 'kgPerDay'],
    [{ kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1/TANK1', kgPerDay: 0.1, startDay: 10, escalations: [{ day: 5, kgPerDay: 1 }] }, '고장 시작보다 뒤'],
    [{ kind: 'fault.flowmeter_drift', site: 'SIM-B', pctPerMonth: 0 }, 'pctPerMonth'],
    [{ kind: 'fault.elz_sec_rise', site: 'SIM-A', mode: 'stack', pct: 5 }, 'h2.elz'],
    [{ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'membrane' as ElzSecRiseMode, pct: 5 }, 'mode'],
    [{ kind: 'fault.fc_air_filter_clog', site: 'SIM-B', pct: 20, startDay: 30, cleanedDay: 20 }, 'cleanedDay'],
    [{ kind: 'fault.pv_soiling', site: 'SIM-A', asset: 'ESS1/RACK01', pctPerDay: 0.1 }, 'pv.inverter'],
    [{ kind: 'fault.inverter_fan_failure', site: 'SIM-A', inverter: 'PV1/INV09', startDay: 1 }, 'PV1/INV09'],
    [{ kind: 'fault.rack_resistance_growth', site: 'SIM-A', rack: 'ESS1/RACK01', pct: 20, rampDays: -1 }, 'rampDays'],
  ] as const)('잘못된 P3 고장 시나리오는 거부한다: %o', (fault, message) => {
    expect(() => resolve(fault)).toThrow(message);
  });
});

describe('planScenarios — P3 고장', () => {
  it('hook은 설비 단위 조회기로, 강한 비·세척·필터 교체는 계획 이벤트로 들어간다', () => {
    const plans = planScenarios(SIM_SITES, [
      { kind: 'fault.pv_soiling', site: 'SIM-A', pctPerDay: 0.1, rainDays: [3] },
      { kind: 'fault.inverter_fan_failure', site: 'SIM-A', inverter: 'PV1/INV02', startDay: 1 },
      { kind: 'fault.fc_air_filter_clog', site: 'SIM-B', pct: 10, cleanedDay: 5 },
    ], { originMs: ORIGIN });
    const simA = plans.get('SIM-A');
    const resolver = createDegradationResolver(simA?.faults ?? []);

    expect(resolver.value('pv.stickySoilingPerDay', 'PV1/INV03', day(1))).toBeCloseTo(0.001, 12);
    expect(resolver.value('inverter.coolingLoss', 'PV1/INV02', day(2))).toBe(1);
    expect(resolver.value('inverter.coolingLoss', 'PV1/INV01', day(2))).toBe(0);
    expect(simA?.rainWindows).toEqual([{ startMs: day(3, 3), endMs: day(3, 9) }]);
    expect(plans.get('SIM-B')?.filterReplacements).toEqual([{ atMs: day(5, 10), assetCode: 'FC1/BLOWER1' }]);
  });

  it('대조군 사이트에는 넣을 수 없고, 건강한 물질수지 구간은 고장이 있는 사이트에 둘 수 없다', () => {
    expect(() => planScenarios(SIM_SITES, [{ kind: 'fault.tank_leak', site: 'SIM-C', tank: 'H2BANK1/TANK1', kgPerDay: 0.1, startDay: 0 }], { originMs: ORIGIN })).toThrow('대조군');
    expect(() =>
      planScenarios(SIM_SITES, [
        { kind: 'control.healthy_mass_balance', site: 'SIM-B', startDay: 0, days: 30 },
        { kind: 'fault.compressor_valve_wear', site: 'SIM-B', pct: 5 },
      ], { originMs: ORIGIN }),
    ).toThrow('고장이 주입된 사이트');
  });
});
