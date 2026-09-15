// P3 고장(연료전지 블로워·전해조 비에너지·유량계·랙 저항)과 대조군(보유 중 충전·높은 압력비·일교차·고온·비)이 플랜트 참값에 반영되는지 확인한다.
import { describe, expect, it } from 'vitest';
import { median } from '@/lib/analytics/stats/robust';
import { DAYS_PER_MONTH } from './fault-scenarios';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { blowerPowerKw, fuelCellParams } from './models/fuelcell';
import { createPlant } from './plant';
import { between, runSite, simSite, sumOf, type Keep, type View } from './plant-test-fixtures';
import { nameplateNumber, singleAsset } from './plant-types';
import { planScenarios, scenarioOriginMs, type Scenario } from './scenarios';

const RUNNING = 3;

describe('연료전지 블로워 — SIM-B 필터 막힘·교체 회복, 마모', () => {
  const from = Date.parse('2026-05-01T00:00:00+09:00');
  const sim = simSite('SIM-B');
  const fcParams = fuelCellParams({
    cellCount: nameplateNumber(singleAsset(sim, 'fc.stack'), 'cell_count'),
    activeAreaCm2: nameplateNumber(singleAsset(sim, 'fc.stack'), 'active_area_cm2'),
    ratedCurrentA: nameplateNumber(singleAsset(sim, 'fc.stack'), 'rated_current_a'),
    ratedAcKw: nameplateNumber(singleAsset(sim, 'fc.plant'), 'rated_kw'),
    blowerRatedKw: nameplateNumber(singleAsset(sim, 'fc.blower'), 'rated_kw'),
    coolantRatedLpm: nameplateNumber(singleAsset(sim, 'fc.cooling'), 'rated_flow_l_min'),
  });
  const keep: Keep = [['FC1/BLOWER1', 'blower.power'], ['FC1/BLOWER1', 'blower.flow'], ['WX1', 'ambient.temp']];
  /** 같은 유량·외기에서 건강한 블로워 대비 (기저 제외) 전력 배율 — 그날 운전 스텝 중앙값 */
  const powerFactor = (views: readonly View[], day: number) =>
    median(
      between(views, from + day * MS_PER_DAY, from + (day + 1) * MS_PER_DAY)
        .filter((v) => v.value('FC1/BLOWER1', 'blower.flow') > 0)
        .map((v) => (v.value('FC1/BLOWER1', 'blower.power') - fcParams.blowerBaseKw) / (blowerPowerKw(fcParams, v.value('FC1/BLOWER1', 'blower.flow'), 0, 0, v.value('WX1', 'ambient.temp')) - fcParams.blowerBaseKw)),
    );

  it('fault.fc_air_filter_clog 25%: 막힌 날은 같은 유량에 전력 1.25배, cleanedDay(3일째 10시) 필터 교체 뒤에는 1배로 돌아온다', () => {
    const views = runSite('SIM-B', from, 5, [{ kind: 'fault.fc_air_filter_clog', site: 'SIM-B', pct: 25, startDay: 1, rampDays: 0, cleanedDay: 3 }], keep);

    expect(powerFactor(views, 0)).toBeCloseTo(1, 6);
    expect(powerFactor(views, 2)).toBeCloseTo(1.25, 6);
    expect(powerFactor(views, 4)).toBeCloseTo(1, 6);
  }, 60_000);

  it('fault.fc_blower_wear 월 30%: 약 한 달 뒤 같은 유량에 전력 약 1.3배', () => {
    const views = runSite('SIM-B', from, 32, [{ kind: 'fault.fc_blower_wear', site: 'SIM-B', pctPerMonth: 30, startDay: 1 }], keep);

    expect(powerFactor(views, 0)).toBeCloseTo(1, 6);
    expect(powerFactor(views, 31)).toBeGreaterThan(1.28);
    expect(powerFactor(views, 31)).toBeLessThan(1.32);
  }, 60_000);
});

describe('전해조 비에너지 상승·유량계 드리프트 — SIM-B', () => {
  const from = Date.parse('2026-05-01T00:00:00+09:00');
  const keep: Keep = [['ELZ1', 'ac.power'], ['ELZ1', 'h2.flow.mass'], ['ELZ1', 'h2.in.o2'], ['ELZ1', 'op.state'], ['ELZ1/RECT1', 'rectifier.efficiency'], ['ELZ1/STACK1', 'cell.voltage.avg'], ['ELZ1/STACK1', 'stack.current']];
  const faultOf = (mode: 'rectifier' | 'faradaic' | 'stack'): Scenario[] => [{ kind: 'fault.elz_sec_rise', site: 'SIM-B', mode, pct: 6, startDay: 0, rampDays: 0 }];
  const nearRated = (views: readonly View[]) => views.filter((v) => v.value('ELZ1', 'op.state') === RUNNING && v.value('ELZ1', 'ac.power') >= 460 && v.value('ELZ1', 'h2.flow.mass') > 0);
  /** 정격 부근(설비 AC 460 kW 이상) 운전 스텝의 비에너지 [kWh/kg] */
  const sec = (views: readonly View[]) => sumOf(nearRated(views), 'ELZ1', 'ac.power') / sumOf(nearRated(views), 'ELZ1', 'h2.flow.mass');
  const meanOf = (views: readonly View[], asset: string, metric: string) => sumOf(nearRated(views), asset, metric) / nearRated(views).length;

  it('정류기·패러데이·셀 전압 경로 모두 정격 부근 비에너지가 6% ± 1%p 오르고, 경로마다 원인 신호(정류기 효율·수소 중 산소·셀 전압)가 따로 보인다', () => {
    const base = runSite('SIM-B', from, 6, [], keep);
    const [rectifier, faradaic, stack] = (['rectifier', 'faradaic', 'stack'] as const).map((mode) => runSite('SIM-B', from, 6, faultOf(mode), keep));
    if (!rectifier || !faradaic || !stack) throw new Error('실행 없음');
    const rise = (views: readonly View[]) => (sec(views) / sec(base) - 1) * 100;

    for (const views of [rectifier, faradaic, stack]) {
      expect(rise(views)).toBeGreaterThan(5);
      expect(rise(views)).toBeLessThan(7);
    }
    expect(meanOf(base, 'ELZ1/RECT1', 'rectifier.efficiency') - meanOf(rectifier, 'ELZ1/RECT1', 'rectifier.efficiency')).toBeGreaterThan(4);
    expect(meanOf(faradaic, 'ELZ1', 'h2.in.o2') / meanOf(base, 'ELZ1', 'h2.in.o2')).toBeGreaterThan(1.3);
    expect(meanOf(stack, 'ELZ1/STACK1', 'cell.voltage.avg') - meanOf(base, 'ELZ1/STACK1', 'cell.voltage.avg')).toBeGreaterThan(0.08);
    expect(Math.abs(meanOf(faradaic, 'ELZ1/RECT1', 'rectifier.efficiency') - meanOf(base, 'ELZ1/RECT1', 'rectifier.efficiency'))).toBeLessThan(0.2);
  }, 120_000);

  it('fault.flowmeter_drift 월 +3%: 계량 유량만 늘고(약 한 달 뒤 +3%) 스택 전류는 그대로다', () => {
    const base = runSite('SIM-B', from, 32, [], keep);
    const drift = runSite('SIM-B', from, 32, [{ kind: 'fault.flowmeter_drift', site: 'SIM-B', pctPerMonth: 3, startDay: 0 }], keep);
    const lastDay = (views: readonly View[]) => between(views, from + 31 * MS_PER_DAY, from + 32 * MS_PER_DAY);

    expect(sumOf(lastDay(drift), 'ELZ1', 'h2.flow.mass') / sumOf(lastDay(base), 'ELZ1', 'h2.flow.mass')).toBeCloseTo(1 + 0.03 * (31.5 / DAYS_PER_MONTH), 2);
    expect(sumOf(drift, 'ELZ1/STACK1', 'stack.current')).toBe(sumOf(base, 'ELZ1/STACK1', 'stack.current'));
  }, 120_000);
});

describe('ESS 랙 저항 증가 — SIM-A', () => {
  // ΔV/ΔI에는 두 샘플 사이 SOC 변화에 따른 OCV 변화가 섞여 정확히 1.5배는 아니다
  it('fault.rack_resistance_growth 50%: 60초 샘플 전류 계단의 ΔV/ΔI가 동종 랙보다 약 1.5배 (1.4~1.7)', () => {
    const from = Date.parse('2026-05-10T00:00:00+09:00');
    const racks = ['ESS1/RACK01', 'ESS1/RACK02'];
    const views = runSite('SIM-A', from, 3, [{ kind: 'fault.rack_resistance_growth', site: 'SIM-A', rack: 'ESS1/RACK02', pct: 50, startDay: 0, rampDays: 0 }], racks.flatMap((r) => [[r, 'batt.current'], [r, 'batt.voltage']] as const));
    const stepResistance = (rack: string) => {
      const values = views.slice(1).flatMap((cur, i) => {
        const prev = views[i];
        const dI = prev ? cur.value(rack, 'batt.current') - prev.value(rack, 'batt.current') : 0;
        return prev && Math.abs(dI) >= 60 ? [(cur.value(rack, 'batt.voltage') - prev.value(rack, 'batt.voltage')) / dI] : [];
      });
      return { n: values.length, median: median(values) };
    };
    const healthy = stepResistance('ESS1/RACK01');
    const grown = stepResistance('ESS1/RACK02');

    expect(healthy.n).toBeGreaterThan(5);
    expect(grown.median / healthy.median).toBeGreaterThan(1.4);
    expect(grown.median / healthy.median).toBeLessThan(1.7);
  }, 60_000);
});

describe('P3 대조군 — SIM-C', () => {
  const from = Date.parse('2026-04-01T00:00:00+09:00');
  const at = (views: readonly View[], tMs: number): View => {
    const view = views.find((v) => v.tMs === tMs);
    if (!view) throw new Error(`스텝 없음: ${new Date(tMs).toISOString()}`);
    return view;
  };

  it('control.tank_refill_topoff: 밤 02~03시 전해조가 최소부하로 돌아 압축기가 돌고 저장뱅크 압력이 오른다 (조건 없는 실행은 그 시간에 정지)', () => {
    const keep: Keep = [['ELZ1', 'ac.power'], ['COMP1', 'op.state'], ['H2BANK1/TANK1', 'tank.pressure']];
    const base = runSite('SIM-C', from, 3, [], keep);
    const topoff = runSite('SIM-C', from, 3, [{ kind: 'control.tank_refill_topoff', site: 'SIM-C', startDay: 1 }], keep);
    const night = (views: readonly View[]) => between(views, from + 2 * MS_PER_DAY + 2 * MS_PER_HOUR + 30 * MS_PER_MINUTE, from + 2 * MS_PER_DAY + 3 * MS_PER_HOUR);
    const before = from + 2 * MS_PER_DAY + 1 * MS_PER_HOUR + 55 * MS_PER_MINUTE;
    const after = from + 2 * MS_PER_DAY + 3 * MS_PER_HOUR + 30 * MS_PER_MINUTE;
    const rise = (views: readonly View[]) => at(views, after).value('H2BANK1/TANK1', 'tank.pressure') - at(views, before).value('H2BANK1/TANK1', 'tank.pressure');

    expect(night(base).every((v) => v.value('COMP1', 'op.state') !== RUNNING)).toBe(true);
    expect(night(topoff).some((v) => v.value('COMP1', 'op.state') === RUNNING)).toBe(true);
    expect(Math.max(...night(topoff).map((v) => v.value('ELZ1', 'ac.power')))).toBeGreaterThan(90);
    expect(rise(topoff)).toBeGreaterThan(rise(base) + 1);
  }, 60_000);

  it('control.compressor_high_ratio_week: 흡입 압력 15 bar로 운전하고 같은 유량에 압축기 전력이 오른다', () => {
    const keep: Keep = [['COMP1', 'compressor.power'], ['COMP1', 'compressor.suction.pressure'], ['COMP1', 'op.state'], ['ELZ1', 'h2.flow.mass']];
    const base = runSite('SIM-C', from, 3, [], keep);
    const high = runSite('SIM-C', from, 3, [{ kind: 'control.compressor_high_ratio_week', site: 'SIM-C', startDay: 1 }], keep);
    const running = (views: readonly View[]) => between(views, from + MS_PER_DAY, from + 3 * MS_PER_DAY).filter((v) => v.value('COMP1', 'op.state') === RUNNING && v.value('ELZ1', 'h2.flow.mass') > 0);
    const kwhPerKg = (views: readonly View[]) => sumOf(running(views), 'COMP1', 'compressor.power') / sumOf(running(views), 'ELZ1', 'h2.flow.mass');

    expect(running(high).length).toBeGreaterThan(60);
    expect(running(high).every((v) => v.value('COMP1', 'compressor.suction.pressure') === 15)).toBe(true);
    expect(kwhPerKg(high) / kwhPerKg(base)).toBeGreaterThan(1.1);
  }, 60_000);

  it('control.day_night_swing · hot_week · rainy_week: 용기 온도 일교차 확대, 외기 +8 °C, 비 오는 주 일사량 감소', () => {
    const keep: Keep = [['H2BANK1/TANK1', 'tank.temp'], ['WX1', 'ambient.temp'], ['WX1', 'poa.irradiance']];
    const base = runSite('SIM-C', from, 12, [], keep);
    const controlled = runSite('SIM-C', from, 12, [
      { kind: 'control.day_night_swing', site: 'SIM-C', startDay: 1 },
      { kind: 'control.hot_week', site: 'SIM-C', startDay: 4 },
      { kind: 'control.rainy_week', site: 'SIM-C', startDay: 5 },
    ], keep);
    const swing = (views: readonly View[]) => {
      const temps = between(views, from + 3 * MS_PER_DAY, from + 4 * MS_PER_DAY).map((v) => v.value('H2BANK1/TANK1', 'tank.temp'));
      return Math.max(...temps) - Math.min(...temps);
    };
    const poa = (views: readonly View[]) => sumOf(between(views, from + 5 * MS_PER_DAY, from + 12 * MS_PER_DAY), 'WX1', 'poa.irradiance');
    const noon = from + 8 * MS_PER_DAY + 12 * MS_PER_HOUR;

    expect(swing(controlled) - swing(base)).toBeGreaterThan(4);
    expect(at(controlled, noon).value('WX1', 'ambient.temp') - at(base, noon).value('WX1', 'ambient.temp')).toBeCloseTo(8, 6);
    expect(poa(controlled) / poa(base)).toBeLessThan(0.7);
  }, 60_000);
});

describe('결정성', () => {
  it('P3 고장을 넣어도 같은 시드는 같은 샘플을 낸다', () => {
    const start = Date.parse('2026-06-01T00:00:00+09:00');
    const scenarios: Scenario[] = [
      { kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1/TANK1', kgPerDay: 0.3, startDay: 0 },
      { kind: 'fault.compressor_leak_seal', site: 'SIM-B', rate: 1, startDay: 0 },
      { kind: 'fault.elz_sec_rise', site: 'SIM-B', mode: 'stack', pct: 5, startDay: 0 },
      { kind: 'fault.pv_soiling', site: 'SIM-B', pctPerDay: 0.5, rainDays: [1] },
    ];
    const once = () => {
      const target = simSite('SIM-B');
      const plan = planScenarios([target], scenarios, { originMs: scenarioOriginMs(start) }).get('SIM-B');
      const plant = createPlant({ site: target, seed: 9, startMs: start, stepS: 60, plan });
      return Array.from({ length: 2 * 1_440 }, (_, i) => plant.step(start + (i + 1) * MS_PER_MINUTE).samples);
    };

    expect(once()).toEqual(once());
  }, 60_000);
});
