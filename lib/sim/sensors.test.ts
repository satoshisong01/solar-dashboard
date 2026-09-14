import { describe, expect, it } from 'vitest';
import { METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import type { MetricDef } from '@/db/seed/types';
import { createRng } from './rng';
import { addNoise, decimalsFor, formatRaw, spikeValue, toRawValue } from './sensors';

function metric(key: string): MetricDef {
  const found = METRIC_DEF_BY_KEY.get(key);
  if (!found) throw new Error(key);
  return found;
}

describe('toRawValue / formatRaw', () => {
  it('정규값 = raw × scale + offset 규약을 거꾸로 적용한다 (MPa·K·mV·MΩ)', () => {
    expect(toRawValue({ scale: 10, valueOffset: 0 }, 350)).toBe(35); // bar → MPa
    expect(toRawValue({ scale: 1, valueOffset: -273.15 }, 60)).toBeCloseTo(333.15, 9); // °C → K
    expect(formatRaw(metric('cell.voltage.avg'), { scale: 0.001, valueOffset: 0, sourceUnit: 'mV' }, 3.312_345)).toBe(3312.3);
    expect(formatRaw(metric('insulation.resistance'), { scale: 1000, valueOffset: 0, sourceUnit: 'MΩ' }, 2_345.6)).toBe(2.346);
  });

  it('단위·물리량별 소수 자릿수로 반올림하고 -0을 남기지 않는다', () => {
    expect(decimalsFor(metric('ac.power'), 'kW')).toBe(2);
    expect(decimalsFor(metric('h2.flow.mass'), 'kg/h')).toBe(4);
    expect(decimalsFor(metric('op.state'), '')).toBe(0);
    expect(Object.is(formatRaw(metric('ac.power'), { scale: 1, valueOffset: 0, sourceUnit: 'kW' }, -0.001), 0)).toBe(true);
  });
});

describe('addNoise', () => {
  it('전력·전류의 참값 0은 0으로 남고, 누적 카운터·상태에는 노이즈가 없다', () => {
    const rng = createRng(1);

    expect(addNoise(metric('ac.power'), 0, rng)).toBe(0);
    expect(addNoise(metric('stack.current'), 0, rng)).toBe(0);
    expect(addNoise(metric('ac.energy.total'), 12_345.6, rng)).toBe(12_345.6);
    expect(addNoise(metric('op.state'), 3, rng)).toBe(3);
  });

  it('노이즈 후에도 hard 범위를 벗어나지 않는다 (SOC 0~100, 검지 농도 ≥ 0)', () => {
    const rng = createRng(2);
    for (let i = 0; i < 2_000; i += 1) {
      const soc = addNoise(metric('batt.soc'), 100, rng);
      const ppm = addNoise(metric('gas.detector.ppm'), 0, rng);
      expect(soc).toBeLessThanOrEqual(100);
      expect(ppm).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('spikeValue', () => {
  it('값 크기(또는 기대범위 폭 10%)의 magnitude배만큼 튄다', () => {
    const rng = createRng(3);
    const spiked = spikeValue(metric('ambient.temp'), 20, 3, rng);

    expect(Math.abs(spiked - 20)).toBeCloseTo(60, 9);
    expect(Math.abs(spikeValue(metric('ac.power'), 0, 3, rng))).toBe(3); // 값이 0이면 최소 기준폭 1
  });
});
