import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import { h2MassKg, h2PressureBar } from './h2-eos';
import { initialStorageState, stepStorage, storageParams, totalMassKg, type StorageInput, type StorageState } from './storage';

// SIM-B/C: 용기 4 × 1850 L, 최고 450 bar, 압축기 45 kW · 10 kg/h
const PARAMS = storageParams({ tankCount: 4, tankWaterVolumeL: 1_850, maxBar: 450 }, { ratedKw: 45, capacityKgH: 10 });
const at = (bar: number): StorageState => initialStorageState(PARAMS, bar, 20, { runHours: 0, energyKwh: 0 });
const NO_LEAK = [0, 0, 0, 0];
const input = (extra: Partial<StorageInput>): StorageInput => ({
  inflowKgH: 0,
  outflowKgH: 0,
  suctionBar: 30,
  ambientC: 20,
  envTempC: 20,
  tankLeakKgPerDay: NO_LEAK,
  valveWear: 0,
  sealLeakBar: 0,
  dtS: 60,
  ...extra,
});

function run(state: StorageState, steps: number, extra: (i: number) => Partial<StorageInput>) {
  let current = state;
  const totals = { inKg: 0, outKg: 0, leakKg: 0, ventedKg: 0, sealLossKg: 0 };
  const history = [];
  for (let i = 0; i < steps; i += 1) {
    const step = stepStorage(PARAMS, current, input(extra(i)));
    totals.inKg += step.inKg;
    totals.outKg += step.outKg;
    totals.leakKg += step.leakKg;
    totals.ventedKg += step.ventedKg;
    totals.sealLossKg += step.sealLossKg;
    history.push(step);
    current = step.state;
  }
  return { state: current, totals, history };
}

describe('stepStorage 질량수지', () => {
  it('누설 0이면 Σ유입 − Σ유출 − Δm = 0, 요청 유입 = 저장 + 씰 누설 + 배출 (임의 유량·외기 2000 스텝)', () => {
    const rng = createRng(21);
    const flows = Array.from({ length: 2_000 }, () => ({ inflowKgH: rng.chance(0.6) ? rng.uniform(0, 9) : 0, outflowKgH: rng.chance(0.5) ? rng.uniform(0, 10) : 0, envTempC: rng.uniform(-5, 35) }));
    const start = at(200);
    const { state, totals } = run(start, flows.length, (i) => ({ ...flows[i], sealLeakBar: 5 }));
    const requestedKg = flows.reduce((sum, f) => sum + f.inflowKgH / 60, 0);

    expect(totals.inKg - totals.outKg - (totalMassKg(state) - totalMassKg(start))).toBeCloseTo(0, 9);
    expect(totals.leakKg).toBe(0);
    expect(totals.inKg + totals.sealLossKg + totals.ventedKg).toBeCloseTo(requestedKg, 9);
    expect(totals.sealLossKg).toBeGreaterThan(0);
  });

  it('용기 누설: 보유 중(밸브 닫힘)에는 누설 용기만 압력이 떨어지고, 충전으로 밸브가 열리면 고르게 나뉜다. 총 손실 = 주입량', () => {
    const leaks = [0, 2, 0, 0];
    const start = at(300);
    const hold = run(start, 24, () => ({ tankLeakKgPerDay: leaks, dtS: 3_600 }));
    const [p1, p2] = hold.history.at(-1)?.tankPressureBar ?? [];

    expect(hold.totals.leakKg).toBeCloseTo(2, 9);
    expect(hold.state.tankMassKg[1]).toBeCloseTo((start.tankMassKg[1] ?? 0) - 2, 9);
    expect(hold.state.tankMassKg[0]).toBe(start.tankMassKg[0]);
    expect((p1 ?? 0) - (p2 ?? 0)).toBeGreaterThan(3);
    expect(hold.state.valvesOpen).toBe(false);

    const filled = stepStorage(PARAMS, hold.state, input({ inflowKgH: 6, tankLeakKgPerDay: leaks }));
    const masses = filled.state.tankMassKg;
    expect(filled.state.valvesOpen).toBe(true);
    expect(Math.max(...masses) - Math.min(...masses)).toBeLessThan(1e-9);
    expect(totalMassKg(filled.state) - totalMassKg(hold.state)).toBeCloseTo(filled.inKg - filled.leakKg, 9);
  });

  it('최고 압력이면 압축기가 서고 유입분은 배출(vent)로 잡힌다', () => {
    const full = stepStorage(PARAMS, at(451), input({ inflowKgH: 8 }));

    expect(full.inKg).toBe(0);
    expect(full.ventedKg).toBeCloseTo(8 / 60, 9);
    expect(full.state.compressorOn).toBe(false);
  });

  it('최소 잔압 아래로는 인출하지 않는다', () => {
    const low = stepStorage(PARAMS, at(PARAMS.minBar), input({ outflowKgH: 9 }));

    expect(low.outKg).toBeCloseTo(0, 9);
    expect(low.outflowLimited).toBe(true);
  });
});

describe('저장용기 온도', () => {
  it('충전 중에는 압축열로 가스가 벽보다 뜨거워지고, 보유에 들어가면 벽 온도로 식으며 압력이 함께 떨어진다', () => {
    const filling = run(at(250), 180, () => ({ inflowKgH: 9 }));
    const hot = filling.state;
    const holding = run(hot, 180, () => ({}));

    expect(hot.gasTempC - hot.wallTempC).toBeGreaterThan(3);
    expect(holding.state.gasTempC).toBeLessThan(hot.gasTempC - 2);
    expect(holding.history.at(-1)?.pressureBar ?? 0).toBeLessThan(filling.history.at(-1)?.pressureBar ?? 0);
    expect(totalMassKg(holding.state)).toBe(totalMassKg(hot));
  });

  it('주변 온도 일교차는 벽 열용량 때문에 줄고 늦게 따라온다 (진폭 ±8 °C → 가스 ±5 °C 미만, 최고 시각 2시간 이상 지연)', () => {
    const envAt = (i: number) => 20 + 8 * Math.cos((2 * Math.PI * (i / 60 - 14)) / 24);
    const days = run(at(300), 4 * 1_440, (i) => ({ envTempC: envAt(i) }));
    const lastDay = days.history.slice(3 * 1_440).map((s, i) => ({ minute: i, gas: s.state.gasTempC }));
    const temps = lastDay.map((x) => x.gas);
    const peakMinute = lastDay.reduce((best, x) => (x.gas > best.gas ? x : best)).minute;

    expect((Math.max(...temps) - Math.min(...temps)) / 2).toBeLessThan(5);
    expect((Math.max(...temps) - Math.min(...temps)) / 2).toBeGreaterThan(1);
    expect(peakMinute / 60).toBeGreaterThan(16);
  });
});

describe('압축기', () => {
  it('전력은 유량과 압력비가 클수록 크고 정격을 넘지 않는다', () => {
    const lowRatio = stepStorage(PARAMS, at(80), input({ inflowKgH: 8 }));
    const highRatio = stepStorage(PARAMS, at(420), input({ inflowKgH: 8 }));
    const lowFlow = stepStorage(PARAMS, at(420), input({ inflowKgH: 3 }));

    expect(highRatio.compressorKw).toBeGreaterThan(lowRatio.compressorKw);
    expect(highRatio.compressorKw).toBeGreaterThan(lowFlow.compressorKw);
    expect(highRatio.compressorKw).toBeLessThanOrEqual(PARAMS.compressor.ratedKw);
    expect(highRatio.dischargeBar).toBeGreaterThan(420);
  });

  it('밸브 마모 12%: 같은 압력비·유량에서 압축 전력(고정분 제외)이 12% 늘고 토출 온도가 오른다', () => {
    const healthy = run(at(300), 60, () => ({ inflowKgH: 8 }));
    const worn = run(at(300), 60, () => ({ inflowKgH: 8, valveWear: 0.12 }));
    const fixed = PARAMS.compressor.fixedKw;

    expect(((worn.history[0]?.compressorKw ?? 0) - fixed) / ((healthy.history[0]?.compressorKw ?? 0) - fixed)).toBeCloseTo(1.12, 9);
    expect(worn.state.compressor.dischargeTempC - healthy.state.compressor.dischargeTempC).toBeGreaterThan(5);
  });

  it('높은 압력비(흡입 15 bar)는 마모 없이도 전력을 올린다 (압축기 비에너지 함정)', () => {
    const normal = stepStorage(PARAMS, at(300), input({ inflowKgH: 8 }));
    const lowSuction = stepStorage(PARAMS, at(300), input({ inflowKgH: 8, suctionBar: 15 }));

    expect(lowSuction.compressorKw).toBeGreaterThan(normal.compressorKw * 1.1);
  });

  it('씰 누설: 운전 중 누설 감지 포트 압력이 누설분까지 오르고, 정지하면 대부분 빠진다', () => {
    const running = run(at(300), 30, () => ({ inflowKgH: 8, sealLeakBar: 6 }));
    const stopped = run(running.state, 90, () => ({ sealLeakBar: 6 }));
    const base = PARAMS.compressor.leakDetectBaseBar;

    expect(running.state.compressor.leakDetectBar).toBeGreaterThan(base + 5.5);
    expect(stopped.state.compressor.leakDetectBar).toBeLessThan(base + 2);
    expect(running.totals.sealLossKg / (running.totals.inKg + running.totals.sealLossKg)).toBeCloseTo(0.006, 9);
  });
});

describe('초기 상태', () => {
  it('모든 용기가 같은 압력(220 bar 등)·온도로 시작한다', () => {
    const state = at(220);

    expect(state.tankMassKg).toHaveLength(4);
    expect(h2PressureBar(state.tankMassKg[0] ?? 0, PARAMS.tankVolumeM3, 20)).toBeCloseTo(220, 9);
    expect(state.tankMassKg[3]).toBe(h2MassKg(220, PARAMS.tankVolumeM3, 20));
  });
});
