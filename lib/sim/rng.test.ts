import { describe, expect, it } from 'vitest';
import { createRng, deriveRng, hashSeed } from './rng';

const draw = (count: number, next: () => number) => Array.from({ length: count }, next);

describe('createRng', () => {
  it('같은 시드는 같은 난수열, 다른 시드는 다른 난수열을 만든다', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);

    const first = draw(20, () => a.next());
    expect(draw(20, () => b.next())).toEqual(first);
    expect(draw(20, () => c.next())).not.toEqual(first);
  });

  it('next는 [0, 1) 균등분포다', () => {
    const rng = createRng(7);
    const values = draw(20_000, () => rng.next());
    const mean = values.reduce((s, v) => s + v, 0) / values.length;

    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(mean).toBeCloseTo(0.5, 1);
  });

  it('gaussian은 평균 0, 표준편차 1에 가깝다', () => {
    const rng = createRng(11);
    const values = draw(40_000, () => rng.gaussian());
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);

    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeGreaterThan(0.97);
    expect(sd).toBeLessThan(1.03);
  });
});

describe('hashSeed / deriveRng', () => {
  it('같은 조합은 같은 32비트 시드, 조합이 다르면 다른 시드', () => {
    expect(hashSeed(1, 'SIM-B', 'noise')).toBe(hashSeed(1, 'SIM-B', 'noise'));
    expect(hashSeed(1, 'SIM-B', 'noise')).not.toBe(hashSeed(1, 'SIM-C', 'noise'));
    expect(hashSeed(1, 'SIM-B', 'noise')).toBeLessThanOrEqual(0xffff_ffff);
    expect(Number.isInteger(hashSeed('x'))).toBe(true);
  });

  it('용도별 스트림은 서로 독립이다', () => {
    const noise = deriveRng(5, 'SIM-A', 'noise');
    const events = deriveRng(5, 'SIM-A', 'events');

    expect(draw(5, () => noise.next())).not.toEqual(draw(5, () => events.next()));
  });
});
