import { describe, expect, it } from 'vitest';
import { createRng } from '../rng';
import { h2Compressibility, h2MassKg, h2PressureBar, stepStorage, storageParams, type StorageInput, type StorageState } from './storage';
import { H2_MOLAR_MASS_KG_PER_MOL } from './common';

// SIM-B/C: 용기 4 × 1850 L, 최고 450 bar, 압축기 45 kW · 10 kg/h
const PARAMS = storageParams({ waterVolumeL: 7_400, maxBar: 450 }, { ratedKw: 45, capacityKgH: 10 });
const at = (bar: number): StorageState => ({
  massKg: h2MassKg(bar, PARAMS.volumeM3, 20),
  gasTempC: 20,
  compressorOn: false,
  compressorRunHours: 0,
  compressorEnergyKwh: 0,
  dischargeTempC: 20,
});
const input = (extra: Partial<StorageInput>): StorageInput => ({ inflowKgH: 0, outflowKgH: 0, suctionBar: 30, ambientC: 20, leakKgPerDay: 0, dtS: 60, ...extra });

describe('수소 상태식', () => {
  it('압력 ↔ 질량 변환이 서로 역함수다', () => {
    for (const bar of [30, 100, 250, 450]) {
      expect(h2PressureBar(h2MassKg(bar, 7.4, 15), 7.4, 15)).toBeCloseTo(bar, 8);
    }
  });

  it('450 bar·15 °C에서 Z ≈ 1.27, 밀도 ≈ 29 kg/m³ (실기체 표값 수준)', () => {
    const massKg = h2MassKg(450, 1, 15);
    const molarDensity = massKg / H2_MOLAR_MASS_KG_PER_MOL;

    expect(h2Compressibility(molarDensity)).toBeGreaterThan(1.2);
    expect(h2Compressibility(molarDensity)).toBeLessThan(1.35);
    expect(massKg).toBeGreaterThan(27);
    expect(massKg).toBeLessThan(31);
  });
});

describe('stepStorage 질량수지', () => {
  it('누설 0이면 Σ유입 − Σ유출 − Δm = 0 (임의 유량 1000 스텝)', () => {
    const rng = createRng(21);
    let state = at(200);
    const startMass = state.massKg;
    let inKg = 0;
    let outKg = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const step = stepStorage(PARAMS, state, input({ inflowKgH: rng.uniform(0, 9), outflowKgH: rng.uniform(0, 10), ambientC: rng.uniform(-5, 35) }));
      inKg += step.inKg;
      outKg += step.outKg;
      expect(step.leakKg).toBe(0);
      state = step.state;
    }

    expect(inKg - outKg - (state.massKg - startMass)).toBeCloseTo(0, 9);
    expect(inKg).toBeGreaterThan(0);
  });

  it('누설 파라미터만큼 질량이 줄고 압력이 떨어진다', () => {
    let state = at(300);
    const start = state;
    let leaked = 0;
    for (let i = 0; i < 24; i += 1) {
      const step = stepStorage(PARAMS, state, input({ leakKgPerDay: 2, dtS: 3_600 }));
      leaked += step.leakKg;
      state = step.state;
    }

    expect(leaked).toBeCloseTo(2, 9);
    expect(start.massKg - state.massKg).toBeCloseTo(2, 9);
    expect(h2PressureBar(state.massKg, PARAMS.volumeM3, 20)).toBeLessThan(300);
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

  it('압축기 전력은 유량과 압력비가 클수록 크고 정격을 넘지 않는다', () => {
    const lowRatio = stepStorage(PARAMS, at(80), input({ inflowKgH: 8 }));
    const highRatio = stepStorage(PARAMS, at(420), input({ inflowKgH: 8 }));
    const lowFlow = stepStorage(PARAMS, at(420), input({ inflowKgH: 3 }));

    expect(highRatio.compressorKw).toBeGreaterThan(lowRatio.compressorKw);
    expect(highRatio.compressorKw).toBeGreaterThan(lowFlow.compressorKw);
    expect(highRatio.compressorKw).toBeLessThanOrEqual(PARAMS.compressorRatedKw);
    expect(highRatio.dischargeBar).toBeGreaterThan(420);
  });
});
