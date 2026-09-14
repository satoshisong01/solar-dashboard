// 고장 주입 크기가 물리 모델 출력에 그대로 반영되는지 확인한다 (메모리 모드·플랜트 참값).
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from './math';
import { DAYS_PER_MONTH } from './fault-scenarios';
import { simulateMemory, type MemorySeries, type MemorySimulationResult } from './memory';
import { cellVoltageV, electrolyzerParams } from './models/electrolyzer';
import { fuelCellParams, polarizationCellVoltageV } from './models/fuelcell';
import { createPlant, type PlantStep } from './plant';
import { nameplateNumber, singleAsset } from './plant-types';
import { planScenarios, scenarioOriginMs, type Scenario } from './scenarios';

const FROM = Date.parse('2026-03-01T00:00:00+09:00');
const day = (n: number) => FROM + n * MS_PER_DAY;

function site(code: string): SiteDef {
  const found = SIM_SITES.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found;
}

function seriesOf(result: MemorySimulationResult, key: string): MemorySeries {
  const series = result.series.get(key);
  if (!series) throw new Error(`시계열 없음: ${key}`);
  return series;
}

const lastValue = (series: MemorySeries): number => series.value[series.value.length - 1] ?? Number.NaN;

/** 충전 구간(연속 두 샘플 전류 > 5 A)의 Ah 합 / SOC 변화 = 관측 유효용량 [Ah] */
function observedCapacityAh(result: MemorySimulationResult, rack: string, fromDay: number, toDay: number): number {
  const current = seriesOf(result, `SIM-A/ESS1/${rack}|batt.current`);
  const soc = seriesOf(result, `SIM-A/ESS1/${rack}|batt.soc`);
  let ah = 0;
  let socPct = 0;
  for (let i = 1; i < current.ts.length; i += 1) {
    const t = current.ts[i] ?? 0;
    if (t < day(fromDay) || t >= day(toDay) || (current.value[i] ?? 0) <= 5 || (current.value[i - 1] ?? 0) <= 5) continue;
    ah += (current.value[i] ?? 0) / 60;
    socPct += (soc.value[i] ?? 0) - (soc.value[i - 1] ?? 0);
  }
  return ah / (socPct / 100);
}

function energyKwh(result: MemorySimulationResult, inverter: string, fromDay: number, toDay: number): number {
  const power = seriesOf(result, `SIM-A/PV1/${inverter}|ac.power`);
  return power.value.reduce((sum, kw, i) => ((power.ts[i] ?? 0) >= day(fromDay) && (power.ts[i] ?? 0) < day(toDay) ? sum + kw / 60 : sum), 0);
}

describe('고장 주입 — SIM-A 60일 (메모리 모드)', () => {
  let result: MemorySimulationResult;

  beforeAll(() => {
    result = simulateMemory({
      siteCodes: ['SIM-A'],
      from: FROM,
      to: day(60),
      seed: 7,
      scenarios: [
        { kind: 'fault.battery_capacity_fade', site: 'SIM-A', asset: 'ESS1/RACK01', startDay: 10, totalPct: 5, days: 30 },
        { kind: 'fault.inverter_efficiency_drop', site: 'SIM-A', asset: 'PV1/INV01', pctPoints: 2, startDay: 20 },
      ],
      pointFilter: (p) => (p.classKey === 'ess.rack' && ['batt.soh', 'batt.current', 'batt.soc'].includes(p.metricKey)) || (p.classKey === 'pv.inverter' && p.metricKey === 'ac.power'),
    });
  }, 120_000);

  it('용량 감소 5%: 60일 뒤 SOH가 동종 랙 대비 −5% ± 0.1%p', () => {
    const faulted = lastValue(seriesOf(result, 'SIM-A/ESS1/RACK01|batt.soh'));
    const peer = lastValue(seriesOf(result, 'SIM-A/ESS1/RACK02|batt.soh'));

    expect((faulted / peer - 1) * 100).toBeCloseTo(-5, 0);
    expect(Math.abs((faulted / peer - 1) * 100 + 5)).toBeLessThan(0.1);
  });

  it('용량 감소 5%: 충전 Ah / SOC 변화로 본 유효용량도 시작 전엔 같고 끝난 뒤엔 −5% ± 1%p', () => {
    const before = observedCapacityAh(result, 'RACK01', 0, 10) / observedCapacityAh(result, 'RACK02', 0, 10);
    const after = observedCapacityAh(result, 'RACK01', 45, 60) / observedCapacityAh(result, 'RACK02', 45, 60);

    expect(Math.abs(before - 1) * 100).toBeLessThan(0.5);
    expect(Math.abs((after - 1) * 100 + 5)).toBeLessThan(1);
  });

  it('인버터 효율 −2%p: 시작 전 발전량은 동종과 같고, 시작 뒤 약 −2% (효율 97~98% 기준 −2.0~2.1%)', () => {
    const before = energyKwh(result, 'INV01', 0, 20) / energyKwh(result, 'INV02', 0, 20);
    const after = energyKwh(result, 'INV01', 21, 60) / energyKwh(result, 'INV02', 21, 60);

    expect(Math.abs(before - 1) * 100).toBeLessThan(0.3);
    expect((after - 1) * 100).toBeGreaterThan(-2.4);
    expect((after - 1) * 100).toBeLessThan(-1.8);
  });
});

describe('셀 불균형 — 같은 시드의 고장 유무 비교', () => {
  it('fault.cell_imbalance 30 mV/월: 최고·최저 셀 차이가 경과 일수만큼 벌어지고 다른 값·랙은 같다', () => {
    const options = { siteCodes: ['SIM-A'], from: FROM, to: day(8), seed: 11, pointFilter: (p: { classKey: string }) => p.classKey === 'ess.rack' };
    const healthy = simulateMemory(options);
    const faulted = simulateMemory({ ...options, scenarios: [{ kind: 'fault.cell_imbalance', site: 'SIM-A', asset: 'ESS1/RACK03', mVPerMonth: 30, startDay: 2 }] });
    const spreadDiffMv = (rack: string, atDay: number) => {
      const keys = ['max', 'min'].map((k) => `SIM-A/ESS1/${rack}|cell.voltage.${k}`);
      const index = seriesOf(healthy, keys[0] ?? '').ts.indexOf(day(atDay));
      const spread = (r: MemorySimulationResult) => (seriesOf(r, keys[0] ?? '').value[index] ?? 0) - (seriesOf(r, keys[1] ?? '').value[index] ?? 0);
      return (spread(faulted) - spread(healthy)) * 1000;
    };

    expect(Math.abs(spreadDiffMv('RACK03', 1.5))).toBeLessThan(0.3);
    expect(spreadDiffMv('RACK03', 7.5)).toBeCloseTo((30 * 5.5) / DAYS_PER_MONTH, 0);
    expect(spreadDiffMv('RACK04', 7.5)).toBe(0);
    expect(Array.from(seriesOf(faulted, 'SIM-A/ESS1/RACK03|batt.current').value)).toEqual(Array.from(seriesOf(healthy, 'SIM-A/ESS1/RACK03|batt.current').value));
  }, 60_000);
});

interface ResidualPoint {
  readonly tMs: number;
  readonly runHoursBefore: number;
  readonly residualV: number;
}

type Readings = Readonly<Record<string, number>>;

/** 운전 중 스텝마다 (직전 누적 운전시간, 셀 전압에서 열화 없는 모델 전압을 뺀 잔차 = 직전까지 누적 열화)를 모은다 */
function residualCollector(stackCode: string, residual: (readings: Readings, previous: Readings) => number) {
  const points: ResidualPoint[] = [];
  let previous: Readings | undefined;
  return {
    points,
    visit(step: PlantStep): void {
      const readings = step.readings.get(stackCode);
      if (!readings) throw new Error(stackCode);
      if (previous && (readings['stack.current'] ?? 0) > 0) {
        points.push({ tMs: step.tMs, runHoursBefore: previous['run.hours'] ?? 0, residualV: residual(readings, previous) });
      }
      previous = readings;
    },
  };
}

/** 두 운전 스텝 사이 잔차 기울기 [µV/h] */
function slopeUvPerH(points: readonly ResidualPoint[]): number {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || last.runHoursBefore === first.runHoursBefore) throw new Error('운전 스텝이 부족합니다');
  return ((last.residualV - first.residualV) / (last.runHoursBefore - first.runHoursBefore)) * 1e6;
}

function* runPlant(target: SiteDef, days: number, scenarios: readonly Scenario[]): Generator<PlantStep> {
  const plan = planScenarios([target], scenarios, { originMs: scenarioOriginMs(FROM) }).get(target.code);
  const plant = createPlant({ site: target, seed: 5, startMs: FROM, stepS: 60, plan });
  for (let t = FROM + MS_PER_MINUTE; t <= day(days); t += MS_PER_MINUTE) yield plant.step(t);
}

describe('스택 열화 — SIM-B 12일 (플랜트 참값)', () => {
  const sim = site('SIM-B');
  const elzParams = electrolyzerParams({
    cellCount: nameplateNumber(singleAsset(sim, 'h2.elz.stack'), 'cell_count'),
    activeAreaCm2: nameplateNumber(singleAsset(sim, 'h2.elz.stack'), 'active_area_cm2'),
    ratedCurrentA: nameplateNumber(singleAsset(sim, 'h2.elz.stack'), 'rated_current_a'),
    ratedAcKw: nameplateNumber(singleAsset(sim, 'h2.elz'), 'rated_kw'),
    rectifierRatedDcKw: nameplateNumber(singleAsset(sim, 'h2.elz.rectifier'), 'rated_dc_kw'),
    outletBar: nameplateNumber(singleAsset(sim, 'h2.elz'), 'outlet_bar'),
  });
  const fcParams = fuelCellParams({
    cellCount: nameplateNumber(singleAsset(sim, 'fc.stack'), 'cell_count'),
    activeAreaCm2: nameplateNumber(singleAsset(sim, 'fc.stack'), 'active_area_cm2'),
    ratedCurrentA: nameplateNumber(singleAsset(sim, 'fc.stack'), 'rated_current_a'),
    ratedAcKw: nameplateNumber(singleAsset(sim, 'fc.plant'), 'rated_kw'),
    blowerRatedKw: nameplateNumber(singleAsset(sim, 'fc.blower'), 'rated_kw'),
    coolantRatedLpm: nameplateNumber(singleAsset(sim, 'fc.cooling'), 'rated_flow_l_min'),
  });
  const faultStart = day(5);
  let elz: ResidualPoint[] = [];
  let fc: ResidualPoint[] = [];

  beforeAll(() => {
    // 전해조 셀 전압은 직전 스텝의 스택 온도로 계산된다
    const elzCollector = residualCollector('ELZ1/STACK1', (r, prev) => (r['cell.voltage.avg'] ?? 0) - cellVoltageV(elzParams, (r['stack.current'] ?? 0) / elzParams.activeAreaCm2, prev['stack.temp'] ?? 0, 0));
    const fcCollector = residualCollector('FC1/STACK1', (r) => polarizationCellVoltageV(fcParams, (r['stack.current'] ?? 0) / fcParams.activeAreaCm2, 0) - (r['cell.voltage.avg'] ?? 0));
    const scenarios: readonly Scenario[] = [
      { kind: 'fault.elz_stack_degradation', site: 'SIM-B', uvPerH: 25, startDay: 5 },
      { kind: 'fault.fc_voltage_decay', site: 'SIM-B', uvPerH: 30, startDay: 5 },
    ];
    for (const step of runPlant(sim, 12, scenarios)) {
      elzCollector.visit(step);
      fcCollector.visit(step);
    }
    elz = elzCollector.points;
    fc = fcCollector.points;
  }, 120_000);

  it('전해조: 시작 전 기울기는 기본 4 µV/h, 시작 뒤 주입한 25 µV/h (운전시간 기준)', () => {
    expect(slopeUvPerH(elz.filter((p) => p.tMs <= faultStart))).toBeCloseTo(4, 3);
    expect(slopeUvPerH(elz.filter((p) => p.tMs > faultStart + MS_PER_HOUR))).toBeCloseTo(25, 3);
  });

  it('연료전지: 시작 전 기울기는 기본 6 µV/h, 시작 뒤 주입한 30 µV/h (운전시간 기준)', () => {
    expect(slopeUvPerH(fc.filter((p) => p.tMs <= faultStart))).toBeCloseTo(6, 3);
    expect(slopeUvPerH(fc.filter((p) => p.tMs > faultStart + MS_PER_HOUR))).toBeCloseTo(30, 3);
  });
});
