import { describe, expect, it } from 'vitest';
import { faradayH2KgPerH } from './common';
import {
  airFlowKgH,
  blowerPowerKw,
  fuelCellParams,
  polarizationCellVoltageV,
  stepFuelCell,
  type FuelCellInput,
  type FuelCellState,
  type FuelCellStep,
} from './fuelcell';

// SIM-B/C 명판: 셀 400, 800 cm², 820 A, 200 kW, 블로워 15 kW, 냉각 200 L/min
const PARAMS = fuelCellParams({ cellCount: 400, activeAreaCm2: 800, ratedCurrentA: 820, ratedAcKw: 200, blowerRatedKw: 15, coolantRatedLpm: 200 });
const OFF: FuelCellState = { mode: 'off', modeElapsedS: 0, stackTempC: 20, runHours: 0, starts: 0, purges: 0, purgeChargeAs: 0, decayV: 0, energyKwh: 0 };

function run(steps: number, extra: Partial<FuelCellInput> = {}, from: FuelCellState = OFF): FuelCellStep[] {
  const results: FuelCellStep[] = [];
  let state = from;
  for (let i = 0; i < steps; i += 1) {
    const step = stepFuelCell(PARAMS, state, {
      command: { run: true, acKw: 150 },
      hydrogenAvailable: true,
      ambientC: 20,
      voltageDecayUvPerH: 0,
      blowerWear: 0,
      dtS: 60,
      ...extra,
    });
    results.push(step);
    state = step.state;
  }
  return results;
}

describe('polarizationCellVoltageV', () => {
  it('운전 전류밀도(0.05~1.0 A/cm²)에서 셀 전압은 0.55~1.0 V 안이고 전류가 늘수록 낮아진다', () => {
    const densities = Array.from({ length: 20 }, (_, i) => 0.05 + (0.95 * i) / 19);
    const voltages = densities.map((j) => polarizationCellVoltageV(PARAMS, j, 0));

    voltages.forEach((v) => {
      expect(v).toBeGreaterThan(0.55);
      expect(v).toBeLessThan(1.0);
    });
    voltages.slice(1).forEach((v, i) => expect(v).toBeLessThan(voltages[i] ?? Infinity));
    expect(polarizationCellVoltageV(PARAMS, 0, 0.002)).toBeCloseTo(PARAMS.openCircuitV - 0.002, 12);
  });
});

describe('stepFuelCell', () => {
  it('기동 후 150 kW로 운전하고, 셀 전압이 분극곡선 범위에 있다', () => {
    const history = run(30);
    const last = history.at(-1);

    expect(history[0]?.state.mode).toBe('starting');
    expect(last?.state.mode).toBe('running');
    expect(last?.acKw).toBeCloseTo(150, 1);
    expect(last?.cellVoltageV).toBeGreaterThan(0.6);
    expect(last?.cellVoltageV).toBeLessThan(0.85);
    expect(last?.coolantOutC).toBeGreaterThan(last?.coolantInC ?? Infinity);
  });

  it('수소 소비 = 패러데이 소비 / 이용률(퍼지 손실 포함)', () => {
    const last = run(30).at(-1);
    if (!last) throw new Error('이력 없음');

    expect(last.h2KgPerH).toBeCloseTo(faradayH2KgPerH(PARAMS.cellCount, last.currentA) / PARAMS.hydrogenUtilization, 9);
    expect(last.h2KgPerH).toBeGreaterThan(faradayH2KgPerH(PARAMS.cellCount, last.currentA));
  });

  it('수소가 없거나 지령이 꺼지면 정지 절차를 거쳐 off가 된다', () => {
    const running = run(30).at(-1)?.state;
    const starved = run(5, { hydrogenAvailable: false }, running);

    expect(starved[0]?.state.mode).toBe('stopping');
    expect(starved[0]?.currentA).toBe(0);
    expect(starved.at(-1)?.state.mode).toBe('off');
  });

  it('애노드 퍼지 카운트가 통과 전하량에 비례해 늘어난다', () => {
    const history = run(120);
    const last = history.at(-1);
    const chargeAs = history.reduce((sum, s) => sum + s.currentA * 60, 0);

    expect(last?.state.purges).toBe(Math.floor(chargeAs / PARAMS.purgeChargeAs));
  });
});

describe('열화 hook', () => {
  it('fc.voltageDecayUvPerH: 운전시간이 쌓일수록 같은 전류의 셀 전압이 낮아진다', () => {
    const history = run(300, { voltageDecayUvPerH: 50, dtS: 3_600 });
    const early = history[10];
    const late = history[299];
    if (!early || !late) throw new Error('이력 부족');
    const hours = late.state.runHours - early.state.runHours;

    expect(late.cellVoltageV).toBeLessThan(early.cellVoltageV);
    expect(late.state.decayV - early.state.decayV).toBeCloseTo(50e-6 * hours, 9);
    // 같은 전류밀도에서 비교해도 감쇠만큼 낮다 (출력 지령을 맞추려 전류가 늘어난 효과 제외)
    expect(polarizationCellVoltageV(PARAMS, early.currentDensityAcm2, late.state.decayV)).toBeLessThan(early.cellVoltageV - 0.01);
  });

  it('blower.wear: 같은 유량에서 블로워 전력이 늘어난다', () => {
    const flow = airFlowKgH(PARAMS, 600);
    const fresh = blowerPowerKw(PARAMS, flow, 0);
    const worn = blowerPowerKw(PARAMS, flow, 0.2);

    expect(worn - PARAMS.blowerBaseKw).toBeCloseTo((fresh - PARAMS.blowerBaseKw) / 0.8, 9);
  });
});
