import { describe, expect, it } from 'vitest';
import { currentLimitsA, lfpOcvV, rackParams, stepRack, type RackInput, type RackState } from './battery';

const PARAMS = rackParams(600, 260, 2); // 832 V · 600 Ah ≈ 500 kWh
const input = (powerKw: number, extra: Partial<RackInput> = {}): RackInput => ({
  powerKw,
  roomTempC: 24,
  capacityFadePerDay: 0,
  cellImbalance: 0.01,
  dtS: 60,
  ...extra,
});

function run(state: RackState, powerKw: number, minutes: number, extra: Partial<RackInput> = {}) {
  let current = state;
  const socs: number[] = [];
  let last = stepRack(PARAMS, current, input(powerKw, { ...extra, dtS: 0 }));
  for (let i = 0; i < minutes; i += 1) {
    last = stepRack(PARAMS, current, input(powerKw, extra));
    current = last.state;
    socs.push(current.soc);
  }
  return { state: current, socs, last };
}

describe('lfpOcvV', () => {
  it('SOC에 대해 단조 증가하고 10~90% 구간은 평탄(0.15 V 이내)하다', () => {
    const socs = Array.from({ length: 101 }, (_, i) => i / 100);
    const values = socs.map(lfpOcvV);

    values.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(values[i] ?? 0));
    expect(lfpOcvV(0.9) - lfpOcvV(0.1)).toBeLessThan(0.15);
    expect(lfpOcvV(-1)).toBe(lfpOcvV(0));
    expect(lfpOcvV(2)).toBe(lfpOcvV(1));
  });
});

describe('stepRack', () => {
  it('과도한 충방전 명령에도 SOC는 0~100% 안에 머문다', () => {
    const charged = run({ soc: 0.5, soh: 1, tempC: 25 }, 5_000, 8 * 60);
    const discharged = run(charged.state, -5_000, 10 * 60);
    const all = [...charged.socs, ...discharged.socs];

    expect(Math.max(...all)).toBeLessThanOrEqual(1);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
    expect(charged.state.soc).toBeGreaterThan(0.95);
    expect(discharged.state.soc).toBeLessThan(0.1);
  });

  it('충전 전류는 0.5C(300 A)를 넘지 않고, 만충 근처에서 줄어든다(CC → 테이퍼)', () => {
    const mid = stepRack(PARAMS, { soc: 0.5, soh: 1, tempC: 25 }, input(500));
    const nearFull = stepRack(PARAMS, { soc: 0.985, soh: 1, tempC: 25 }, input(500));

    expect(mid.mode).toBe('cc');
    expect(mid.currentA).toBeCloseTo(300, 6);
    expect(nearFull.currentA).toBeLessThan(mid.currentA * 0.5);
  });

  it('최고 셀이 충전 상한에 닿으면 CV로 전류를 줄여 상한을 넘지 않는다', () => {
    const lowCutoff = { ...PARAMS, cellVoltageMaxV: 3.46 };
    const cv = stepRack(lowCutoff, { soc: 0.9, soh: 1, tempC: 25 }, input(500, { cellImbalance: 0.2 }));

    expect(cv.mode).toBe('cv');
    expect(cv.currentA).toBeGreaterThan(0);
    expect(cv.currentA).toBeLessThan(300);
    expect(cv.cellVoltageMaxV).toBeCloseTo(lowCutoff.cellVoltageMaxV, 9);
  });

  it('100 kW로 1시간 충전하면 SOC가 약 100 kWh / 500 kWh만큼 오른다', () => {
    const result = run({ soc: 0.3, soh: 1, tempC: 25 }, 100, 60);

    expect(result.state.soc - 0.3).toBeGreaterThan(0.18);
    expect(result.state.soc - 0.3).toBeLessThan(0.22);
  });

  it('용량 감소율만큼 SOH가 줄고, 저온에서는 전류 한계가 줄어든다', () => {
    const faded = run({ soc: 0.5, soh: 1, tempC: 25 }, 0, 30 * 24, { capacityFadePerDay: 0.001, dtS: 3_600 });
    const cold = currentLimitsA(PARAMS, { soc: 0.5, soh: 1, tempC: 2 });
    const warm = currentLimitsA(PARAMS, { soc: 0.5, soh: 1, tempC: 25 });

    expect(faded.state.soh).toBeCloseTo(0.97, 6);
    expect(cold.chargeA).toBeLessThan(warm.chargeA * 0.5);
  });

  it('셀 불균형이 크면 SOC 끝단에서 최고·최저 셀 전압 차가 커진다', () => {
    const spread = (imbalance: number) => {
      const step = stepRack(PARAMS, { soc: 0.93, soh: 1, tempC: 25 }, input(0, { cellImbalance: imbalance }));
      return step.cellVoltageMaxV - step.cellVoltageMinV;
    };

    expect(spread(0.06)).toBeGreaterThan(spread(0.005) + 0.03);
  });

  it('충전 중 랙 온도가 오르고 전압은 OCV보다 높다', () => {
    const result = run({ soc: 0.3, soh: 1, tempC: 24 }, 250, 120);

    expect(result.state.tempC).toBeGreaterThan(24);
    expect(result.last.cellVoltageAvgV).toBeGreaterThan(result.last.ocvV);
    expect(result.last.cellVoltageMaxV).toBeGreaterThanOrEqual(result.last.cellVoltageAvgV);
    expect(result.last.cellVoltageMinV).toBeLessThanOrEqual(result.last.cellVoltageAvgV);
  });
});
