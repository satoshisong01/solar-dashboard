import { describe, expect, it } from 'vitest';
import { faradayH2KgPerH, H2_KG_PER_AMP_HOUR_PER_CELL } from './common';
import {
  cellVoltageV,
  electrolyzerMinKw,
  electrolyzerParams,
  stepElectrolyzer,
  type ElectrolyzerCommand,
  type ElectrolyzerState,
  type ElectrolyzerStep,
} from './electrolyzer';

// SIM-B/C 명판: 셀 210, 550 cm², 1100 A, 설비 500 kW, 정류기 480 kW, 출구 30 bar
const PARAMS = electrolyzerParams({ cellCount: 210, activeAreaCm2: 550, ratedCurrentA: 1_100, ratedAcKw: 500, rectifierRatedDcKw: 480, outletBar: 30 });
const OFF: ElectrolyzerState = { mode: 'off', modeElapsedS: 0, startDurationS: 0, stackTempC: 20, runHours: 0, starts: 0, degradationV: 0, purges: 0, purgeChargeAs: 0, h2TotalKg: 0, energyKwh: 0 };

function run(command: ElectrolyzerCommand, steps: number, dtS: number, degradationUvPerH = 0, from: ElectrolyzerState = OFF): ElectrolyzerStep[] {
  const results: ElectrolyzerStep[] = [];
  let state = from;
  for (let i = 0; i < steps; i += 1) {
    const step = stepElectrolyzer(PARAMS, state, { command, ambientC: 20, degradationUvPerH, dtS });
    results.push(step);
    state = step.state;
  }
  return results;
}

describe('패러데이 수소 생산', () => {
  it('상수: 3600 × 2.01588e-3 / (2 × 96485.33212) ≈ 3.7608e-5 kg/(A·h·셀)', () => {
    expect(H2_KG_PER_AMP_HOUR_PER_CELL).toBeCloseTo(3.760_76e-5, 9);
    expect(faradayH2KgPerH(210, 1_100)).toBeCloseTo(8.687, 3);
  });

  it('운전 중 제품 수소량은 이상 패러데이 계산(η_F = 1)과 1% 이내다', () => {
    const steps = run({ run: true, acKw: 350 }, 180, 60).filter((s) => s.state.mode === 'running');
    const produced = steps.reduce((sum, s) => sum + s.h2ProductKg, 0);
    const faraday = steps.reduce((sum, s) => sum + faradayH2KgPerH(PARAMS.cellCount, s.currentA) / 60, 0);

    expect(steps.length).toBeGreaterThan(150);
    expect(Math.abs(produced / faraday - 1)).toBeLessThan(0.01);
  });
});

describe('stepElectrolyzer 운전 상태', () => {
  it('정지 → 냉간 기동(순도 미달 수소 배출) → 운전 → 정지(퍼지) → 온간 대기', () => {
    const starting = run({ run: true, acKw: 400 }, 5, 60);
    expect(starting[0]?.state.mode).toBe('starting');
    expect(starting[0]?.state.starts).toBe(1);
    expect(starting.every((s) => s.h2ProductKg === 0)).toBe(true);
    expect(starting.some((s) => s.h2VentedKg > 0)).toBe(true);

    const running = run({ run: true, acKw: 400 }, 20, 60, 0, starting.at(-1)?.state);
    expect(running.at(-1)?.state.mode).toBe('running');

    const stopping = run({ run: false, acKw: 0 }, 6, 60, 0, running.at(-1)?.state);
    expect(stopping[0]?.state.mode).toBe('stopping');
    expect(stopping[0]?.currentA).toBe(0);
    expect(stopping.at(-1)?.state.mode).toBe('standby');
  });

  it('최소부하(정격 20%) 미만 지령이면 최소부하로 운전하고, 정격 전류를 넘지 않는다', () => {
    const low = run({ run: true, acKw: 30 }, 40, 60).at(-1);
    const high = run({ run: true, acKw: 2_000 }, 40, 60).at(-1);

    expect(low?.totalAcKw).toBeCloseTo(electrolyzerMinKw(PARAMS), 0);
    expect(high?.currentA).toBeLessThanOrEqual(PARAMS.ratedCurrentA);
    expect(high?.totalAcKw).toBeLessThanOrEqual(PARAMS.ratedAcKw + 1e-6);
  });

  it('정격 운전 시 셀 전압 1.8~2.1 V, 정류기 효율 93~98%', () => {
    const rated = run({ run: true, acKw: 500 }, 120, 60).at(-1);

    expect(rated?.cellVoltageV).toBeGreaterThan(1.8);
    expect(rated?.cellVoltageV).toBeLessThan(2.1);
    expect(rated?.rectifierEfficiency).toBeGreaterThan(0.93);
    expect(rated?.rectifierEfficiency).toBeLessThan(0.98);
  });
});

describe('열화 hook (elz.degradationUvPerH)', () => {
  it('같은 전류에서 셀 전압이 누적 운전시간 × µV/h 만큼 오른다', () => {
    const history = run({ run: true, acKw: 500 }, 250, 3_600, 40); // 정격 전류 고정, 250시간
    const early = history[10];
    const late = history[249];
    if (!early || !late) throw new Error('이력 부족');
    const hours = late.state.runHours - early.state.runHours;

    expect(early.currentA).toBe(PARAMS.ratedCurrentA);
    expect(late.currentA).toBe(PARAMS.ratedCurrentA);
    expect(late.cellVoltageV - early.cellVoltageV).toBeCloseTo(40e-6 * hours, 4);
  });

  it('열화가 없으면 같은 조건의 전압은 그대로다', () => {
    const history = run({ run: true, acKw: 500 }, 100, 3_600, 0);

    expect((history[99]?.cellVoltageV ?? 0) - (history[10]?.cellVoltageV ?? 0)).toBeCloseTo(0, 6);
    expect(cellVoltageV(PARAMS, 2, 60, 0.01) - cellVoltageV(PARAMS, 2, 60, 0)).toBeCloseTo(0.01, 12);
  });
});
