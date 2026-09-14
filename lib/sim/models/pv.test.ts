import { describe, expect, it } from 'vitest';
import { clearSkyIrradiance } from '../weather';
import { inverterEfficiency, simulateInverter, type InverterConditions, type InverterRating } from './pv';

const RATING: InverterRating = { acKw: 500, dcKwp: 500 };
const base: InverterConditions = { poa: 800, ambientC: 25, soiling: 0, efficiencyDrop: 0, limitPct: 100, tripped: false };
const kst = (iso: string) => Date.parse(`${iso}+09:00`);

describe('simulateInverter', () => {
  it('밤(일사 0)에는 출력 0, 잠든 상태다', () => {
    const night = simulateInverter(RATING, { ...base, poa: 0, ambientC: 18 });

    expect(night).toMatchObject({ mode: 'off', acKw: 0, dcKw: 0, dcCurrentA: 0 });
  });

  it.each([
    ['하지', '2026-06-21T12:30:00', 30],
    ['8월 중순', '2026-08-15T12:30:00', 32],
  ])('여름 청천 정오(%s) AC 출력은 정격의 70~90%다', (_label, iso, ambientC) => {
    const clear = clearSkyIrradiance(35.85, 126.55, kst(iso), 30);
    const point = simulateInverter(RATING, { ...base, poa: clear.poa, ambientC });

    expect(point.mode).toBe('running');
    expect(point.acKw / RATING.acKw).toBeGreaterThan(0.7);
    expect(point.acKw / RATING.acKw).toBeLessThan(0.9);
  });

  it('DC가 AC 정격을 넘으면 클리핑하고 MPPT 전압이 개방전압 쪽으로 오른다', () => {
    const overloaded: InverterRating = { acKw: 400, dcKwp: 560 };
    const normal = simulateInverter(overloaded, { ...base, poa: 500 });
    const clipped = simulateInverter(overloaded, { ...base, poa: 1_100, ambientC: 5 });

    expect(clipped.clipped).toBe(true);
    expect(clipped.acKw).toBeCloseTo(400, 6);
    expect(normal.clipped).toBe(false);
    expect(clipped.dcVoltageV).toBeGreaterThan(normal.dcVoltageV);
  });

  it('출력 제한 설정값을 따른다', () => {
    const limited = simulateInverter(RATING, { ...base, poa: 1_000, limitPct: 30 });

    expect(limited.acKw).toBeCloseTo(150, 6);
  });

  it('효율 저하·오염은 출력을 줄이고, 트립이면 0이다', () => {
    const healthy = simulateInverter(RATING, base);
    const degraded = simulateInverter(RATING, { ...base, efficiencyDrop: 0.02 });
    const soiled = simulateInverter(RATING, { ...base, soiling: 0.05 });
    const tripped = simulateInverter(RATING, { ...base, tripped: true });

    expect(degraded.acKw / healthy.acKw).toBeCloseTo(1 - 0.02 / healthy.efficiency, 3);
    expect(soiled.acKw).toBeLessThan(healthy.acKw * 0.96);
    expect(tripped).toMatchObject({ mode: 'fault', acKw: 0 });
    expect(tripped.dcVoltageV).toBeGreaterThan(0); // 트립 중에도 어레이 개방전압은 보인다
  });

  it('DC 전압 × 전류 = DC 전력', () => {
    const point = simulateInverter(RATING, base);

    expect((point.dcVoltageV * point.dcCurrentA) / 1000).toBeCloseTo(point.dcKw, 6);
  });
});

describe('inverterEfficiency', () => {
  it('중·고부하에서 96~98.5%, 5% 저부하에서는 더 낮다', () => {
    for (const load of [0.3, 0.5, 0.75, 1]) {
      const efficiency = inverterEfficiency(500 * load, 500);
      expect(efficiency).toBeGreaterThan(0.96);
      expect(efficiency).toBeLessThan(0.985);
    }
    expect(inverterEfficiency(25, 500)).toBeLessThan(inverterEfficiency(250, 500) - 0.02);
    expect(inverterEfficiency(0, 500)).toBe(0);
  });
});
