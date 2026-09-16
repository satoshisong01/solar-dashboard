import { describe, expect, it } from 'vitest';
import { SEED_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { planScenarios, type Scenario } from './scenarios';
import { DRYER_LOSS_FRACTION } from './plant-hydrogen';
import { hasGapyeongSubsystems, hxOutlets, O2_PER_H2_KG, TRAILER_KG, trailerPressureBar, WATER_L_PER_KG_H2 } from './plant-gapyeong';
import { createPlant } from './plant';
import { MS_PER_DAY } from './math';

const siteOf = (code: string): SiteDef => {
  const found = SEED_SITES.find((s) => s.code === code);
  if (!found) throw new Error(`사이트 없음: ${code}`);
  return found;
};

const SIM_D = siteOf('SIM-D');
const FROM = Date.parse('2026-06-01T00:00:00+09:00');
const STEP_S = 60;
const DAYS = 3;

interface Totals {
  readonly elzKg: number;
  readonly fcKg: number;
  readonly deliveredKg: number;
  readonly o2ProducedKg: number;
  readonly o2ShippedKg: number;
  readonly ventMinutes: number;
  readonly hxKwh: number;
  readonly feedM3: number;
  /** 실행 동안 하역 계량 적산이 늘어난 양 [kg] */
  readonly deliveryMeterDeltaKg: number;
  readonly maxHto: number;
  readonly maxProductConductivity: number;
  readonly prvIdleBar: number;
  readonly coldOutMax: number;
}

/** SIM-D를 days일 돌려 부속 계통 적산값을 모은다 (마지막 스텝 상태도 함께) */
function run(days: number, scenarios: readonly Scenario[] = []): Totals {
  const plans = planScenarios([SIM_D], scenarios, { originMs: FROM });
  const plant = createPlant({ site: SIM_D, seed: 7, startMs: FROM, stepS: STEP_S, plan: plans.get('SIM-D') });
  const dtH = STEP_S / 3_600;
  let t = FROM;
  let elzKg = 0;
  let fcKg = 0;
  let deliveredKg = 0;
  let o2ProducedKg = 0;
  let ventMinutes = 0;
  let hxKwh = 0;
  let feedM3 = 0;
  let maxHto = 0;
  let maxProductConductivity = 0;
  let prvIdleBar = 0;
  let coldOutMax = 0;
  let deliveryMeterFirst: number | null = null;
  let deliveryMeterLast = 0;
  let o2ShippedKg = 0;
  for (let i = 0; i < (days * MS_PER_DAY) / (STEP_S * 1_000); i += 1) {
    t += STEP_S * 1_000;
    const r = createStep(plant, t);
    elzKg += (r('ELZ1', 'h2.flow.mass') ?? 0) * dtH;
    fcKg += (r('FC1', 'fc.h2.consumption') ?? 0) * dtH;
    deliveredKg += (r('H2DLV1', 'h2.delivery.flow.mass') ?? 0) * dtH;
    o2ProducedKg += (r('O2P1', 'o2.flow.mass#production') ?? 0) * dtH;
    ventMinutes += (r('O2P1/TANK1', 'valve.open#o2.vent') ?? 0) > 0 ? 1 : 0;
    hxKwh += (r('FC1/HX1', 'hx.heat.recovered') ?? 0) * dtH;
    feedM3 += (r('ELZ1/WTU1', 'water.flow.feed') ?? 0) * dtH;
    maxHto = Math.max(maxHto, r('O2P1', 'h2.in.o2#o2.product') ?? 0);
    maxProductConductivity = Math.max(maxProductConductivity, r('ELZ1/WTU1', 'water.conductivity#product') ?? 0);
    coldOutMax = Math.max(coldOutMax, r('FC1/HX1', 'hx.temp.cold.out') ?? 0);
    if ((r('FC1', 'fc.h2.consumption') ?? 0) <= 0.05) prvIdleBar = Math.max(prvIdleBar, r('PRV1', 'h2.pressure#fc.inlet') ?? 0);
    deliveryMeterLast = r('H2DLV1', 'h2.delivery.mass.total') ?? 0;
    deliveryMeterFirst ??= deliveryMeterLast;
    o2ShippedKg = r('O2P1/LOAD1', 'o2.shipped.mass.total') ?? 0;
  }
  return { elzKg, fcKg, deliveredKg, o2ProducedKg, o2ShippedKg, ventMinutes, hxKwh, feedM3, deliveryMeterDeltaKg: deliveryMeterLast - (deliveryMeterFirst ?? 0), maxHto, maxProductConductivity, prvIdleBar, coldOutMax };
}

type Plant = ReturnType<typeof createPlant>;
const createStep = (plant: Plant, tMs: number) => {
  const step = plant.step(tMs);
  return (assetCode: string, key: string): number | undefined => step.readings.get(assetCode)?.[key];
};

describe('가평 부속 계통 (SIM-D)', () => {
  it('부속 계통이 있는 사이트만 모델을 붙인다', () => {
    expect(hasGapyeongSubsystems(SIM_D)).toBe(true);
    expect(hasGapyeongSubsystems(siteOf('SIM-B'))).toBe(false);
    // GP-1도 같은 계통 구성이지만 simulated: false라 시뮬레이터가 아예 돌지 않는다 (db/seed/sites.ts)
    expect(hasGapyeongSubsystems(siteOf('GP-1'))).toBe(true);
    expect(siteOf('GP-1').attributes.simulated).toBe(false);
  });

  it('물리 상수는 도면·조사 값과 같다', () => {
    expect(O2_PER_H2_KG).toBeCloseTo(31.998 / (2 * 2.016), 3); // H2O → H2 + ½O2
    expect(WATER_L_PER_KG_H2).toBeCloseTo((0.5 * 1000) / 44.9, 1); // 도면 급수 0.5 m³/h ÷ 44.9 kg/h
    expect(TRAILER_KG).toBe(198); // Type I 잔압 70 bar 기준 실운송량
    expect(trailerPressureBar(TRAILER_KG)).toBe(200);
    expect(trailerPressureBar(0)).toBe(70);
  });

  it('열교환기 ε-NTU: 설계 UA에서 급수 0.5 m³/h를 약 55 °C로 올리고, 오염이 생기면 접근온도가 벌어진다', () => {
    const params = { hxUaKwK: 0.76, hxDutyKw: 350 } as Parameters<typeof hxOutlets>[0];
    const clean = hxOutlets(params, 75, 15, 0.5, 0);
    expect(clean.coldOutC).toBeGreaterThan(50);
    expect(clean.coldOutC).toBeLessThan(60);
    // 도면 350 kWth 중 실제 회수는 20~25 kW뿐이다 (research-heat: 급수 예열 필요열 23.3 kW)
    expect(clean.heatKw).toBeGreaterThan(18);
    expect(clean.heatKw).toBeLessThan(30);
    // 1차측 온도강하가 1 K 수준이라 도면의 '환수 60 °C'는 이 유량으로 성립하지 않는다
    expect(75 - clean.hotOutC).toBeLessThan(2);
    const fouled = hxOutlets(params, 75, 15, 0.5, 0.4);
    expect(fouled.coldOutC).toBeLessThan(clean.coldOutC - 5);
    expect(75 - fouled.coldOutC).toBeGreaterThan(75 - clean.coldOutC + 5); // 접근온도 +5 K 이상
  });

  it(`건강한 ${DAYS}일: 자급률이 낮아 반입이 필요하고, 산소는 버퍼가 작아 방출되며, 폐열은 회수되지만 양이 적다`, () => {
    const t = run(DAYS);
    // 반입: 연료전지 소비가 자체 생산을 크게 넘어 하루 100 kg 이상이 들어온다
    expect(t.fcKg).toBeGreaterThan(t.elzKg * 3);
    expect(t.deliveredKg / DAYS).toBeGreaterThan(100);
    // 자급률(생산 ÷ 소비)은 조사값 범위(10~40%) 안이다
    expect(t.elzKg / t.fcKg).toBeGreaterThan(0.05);
    expect(t.elzKg / t.fcKg).toBeLessThan(0.4);
    // 하역 계량 적산이 실제 반입량을 따라간다
    expect(t.deliveryMeterDeltaKg).toBeCloseTo(t.deliveredKg, -1);
    // 산소: 이론 생산량은 수소의 약 7.94배이고, 압축기가 없어 출하는 0이며 만재 뒤에는 방출한다
    // 계량 수소(elzKg)는 건조기 재생 손실 뒤 값이라 산소 이론 생산량은 그만큼 크다
    expect(t.o2ProducedKg).toBeCloseTo((t.elzKg / (1 - DRYER_LOSS_FRACTION)) * O2_PER_H2_KG, 0);
    expect(t.o2ShippedKg).toBe(0);
    expect(t.ventMinutes).toBeGreaterThan(60);
    // 폐열: 회수는 되지만 설계 350 kWth에 한참 못 미친다 (급수 0.5 m³/h가 받을 수 있는 열이 23 kW뿐)
    expect(t.hxKwh / DAYS).toBeGreaterThan(20);
    expect(t.hxKwh / DAYS).toBeLessThan(350 * 24 * 0.05);
    expect(t.coldOutMax).toBeGreaterThan(45);
    // 물: 급수 적산이 늘고, 전도도는 건강 수준이다
    expect(t.feedM3).toBeGreaterThan(0);
    expect(t.maxProductConductivity).toBeLessThan(0.1);
    // 감압밸브: 무유동 구간 하류 압력이 락업 수준(설정 0.8 bar + 여유)에 머문다
    expect(t.prvIdleBar).toBeGreaterThan(0.8);
    expect(t.prvIdleBar).toBeLessThan(2);
    // HTO는 법정 압축금지선 2 vol% 아래다
    expect(t.maxHto).toBeGreaterThan(0);
    expect(t.maxHto).toBeLessThan(2);
  }, 60_000);

  it('고장 주입: 시트 누설·열교환기 오염·수질 악화·HTO 상승·반입 기록 누락이 각각 측정값에 나타난다', () => {
    const healthy = run(DAYS);

    const prv = run(DAYS, [{ kind: 'fault.prv_seat_leak', site: 'SIM-D', barPerH: 0.3, startDay: 0, rampDays: 0 }]);
    expect(prv.prvIdleBar).toBeGreaterThan(healthy.prvIdleBar + 1);

    const hx = run(DAYS, [{ kind: 'fault.hx_fouling', site: 'SIM-D', pct: 50, startDay: 0, rampDays: 0 }]);
    expect(hx.hxKwh).toBeLessThan(healthy.hxKwh * 0.9);
    expect(hx.coldOutMax).toBeLessThan(healthy.coldOutMax - 5);

    const water = run(DAYS, [{ kind: 'fault.water_quality', site: 'SIM-D', uScmRise: 1.5, startDay: 0, rampDays: 0 }]);
    expect(water.maxProductConductivity).toBeGreaterThan(1);

    const hto = run(DAYS, [{ kind: 'fault.o2_purity_drift', site: 'SIM-D', pctPoints: 1.6, startDay: 0, rampDays: 0 }]);
    expect(hto.maxHto).toBeGreaterThan(2); // 법정 압축금지선 초과

    // 반입 기록 누락: 하역은 그대로인데 적산계가 늘지 않는다 → 원장 delivered가 과소 집계된다
    const unlogged = run(DAYS, [{ kind: 'fault.delivery_unlogged', site: 'SIM-D', startDay: 0, days: DAYS }]);
    expect(unlogged.deliveryMeterDeltaKg).toBe(0);
    expect(unlogged.deliveredKg).toBe(0); // 유량계도 같은 계량기라 0으로 보인다 — 실제 하역은 계속된다
  }, 120_000);
});
