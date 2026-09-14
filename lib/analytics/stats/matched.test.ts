import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { scoreConfidence, relativeCiWidth } from './confidence';
import { matchedRatio } from './matched';

interface Row {
  readonly bin: string;
  readonly value: number;
}

const rows = (bin: string, values: readonly number[]): Row[] => values.map((value) => ({ bin, value }));
const binOf = (r: Row) => r.bin;
const valueOf = (r: Row) => r.value;

describe('matchedRatio', () => {
  it('bin별 중앙값 비율을 최근 표본 수로 가중 결합한다 (알려진 값)', () => {
    const reference = [...rows('a', [100, 100, 100, 100, 100]), ...rows('b', [200, 200, 200, 200, 200])];
    const recent = [...rows('a', [90, 90, 90, 90, 90, 90, 90, 90, 90, 90]), ...rows('b', [190, 190, 190, 190, 190])];
    const result = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(1), minTotal: 10, iterations: 200 });
    // a: 0.9 (가중 10/15), b: 0.95 (가중 5/15) → 0.91667
    expect(result.status).toBe('ok');
    expect(result.ratio).toBeCloseTo(0.9 * (10 / 15) + 0.95 * (5 / 15), 12);
    expect(result.ciLow).toBeCloseTo(result.ratio ?? 0, 12); // 상수 표본 → CI 폭 0
    expect(result.bins).toEqual([
      { key: 'a', nRef: 5, nCur: 10, medRef: 100, medCur: 90, ratio: 0.9, used: true, weight: 10 / 15 },
      { key: 'b', nRef: 5, nCur: 5, medRef: 200, medCur: 190, ratio: 0.95, used: true, weight: 5 / 15 },
    ]);
  });

  it('조건이 겹치지 않는 bin은 버리고, 최근이 저온 bin에만 몰려도 같은 bin끼리만 비교한다', () => {
    const rng = createRng(5);
    const noisy = (mu: number, n: number) => Array.from({ length: n }, () => mu * (1 + 0.003 * rng.gaussian()));
    const reference = [...rows('warm', noisy(400, 20)), ...rows('cold', noisy(360, 16))];
    const recent = [...rows('cold', noisy(337.5, 18)), ...rows('hot', noisy(420, 3))];
    const result = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(7) });
    expect(result.status).toBe('ok');
    expect(result.ratio).toBeCloseTo(0.9375, 2);
    expect(result.bins.find((b) => b.key === 'hot')?.used).toBe(false);
    expect(result.bins.find((b) => b.key === 'warm')?.ratio).toBeNull();
    expect(result.ciLow ?? 0).toBeLessThan(result.ratio ?? 0);
    expect(result.ciHigh ?? 0).toBeGreaterThan(result.ratio ?? 0);
  });

  it('bin당·합계 표본이 모자라면 insufficient와 이유', () => {
    const result = matchedRatio(rows('a', [1, 1, 1, 1, 1, 1]), rows('a', [1, 1, 1, 1]), binOf, valueOf, { rng: createRng(1) });
    expect(result).toMatchObject({ status: 'insufficient', ratio: null, ciLow: null, ciHigh: null, nRef: 0, nCur: 0 });
    if (result.status === 'insufficient') expect(result.reason).toContain('표본 부족');
    const total = matchedRatio(rows('a', [1, 1, 1, 1, 1]), rows('a', [1, 1, 1, 1, 1, Number.NaN]), binOf, valueOf, { rng: createRng(1) });
    expect(total.status).toBe('insufficient');
  });

  it('가중치: bin 통계량은 가중 중앙값, 결합 가중치는 최근 표본 가중치 합 비율 (방법 명시)', () => {
    type WRow = Row & { readonly w: number };
    const wrows = (bin: string, values: readonly (readonly [number, number])[]): WRow[] => values.map(([value, w]) => ({ bin, value, w }));
    // 기준 a: 100 ×3(가중 1) + 불확실한 80 ×2(가중 0.1) → 가중 중앙값 100 (보통 중앙값도 100)
    // 최근 a: 불확실한 70 ×3(가중 0.1) + 확실한 90 ×2(가중 4) → 가중 중앙값 90 (보통 중앙값이면 70)
    const reference = [...wrows('a', [[100, 1], [100, 1], [100, 1], [80, 0.1], [80, 0.1]]), ...wrows('b', [[200, 1], [200, 1], [200, 1]])];
    const recent = [...wrows('a', [[70, 0.1], [70, 0.1], [70, 0.1], [90, 4], [90, 4]]), ...wrows('b', [[180, 1], [180, 1], [180, 1]])];
    const weighted = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(1), minPerBin: 3, minTotal: 5, iterations: 50, weightKey: (r) => r.w });
    expect(weighted.status).toBe('ok');
    const weightA = 8.3 / (8.3 + 3);
    expect(weighted.bins.map((b) => [b.key, b.medCur, b.weight])).toEqual([
      ['a', 90, weightA],
      ['b', 180, 1 - weightA],
    ]);
    expect(weighted.ratio).toBeCloseTo(weightA * 0.9 + (1 - weightA) * 0.9, 12);
    const plain = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(1), minPerBin: 3, minTotal: 5, iterations: 50 });
    expect(plain.bins.find((b) => b.key === 'a')?.medCur).toBe(70);
    // 가중치 0 이하·유한하지 않은 표본은 뺀다
    const dropped = matchedRatio(reference, [...recent, { bin: 'a', value: 1, w: 0 }], binOf, valueOf, { rng: createRng(1), minPerBin: 3, minTotal: 5, iterations: 50, weightKey: (r) => r.w });
    expect(dropped.bins.find((b) => b.key === 'a')?.nCur).toBe(5);
  });

  it('기준 합계 하한을 따로 줄 수 있다 (bin마다 기준을 고르는 경우)', () => {
    const reference = [...rows('a', [100, 100, 100, 100, 100]), ...rows('b', [200, 200, 200, 200, 200])];
    const recent = [...rows('a', Array(10).fill(95)), ...rows('b', Array(10).fill(190))];
    expect(matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(1), iterations: 10 }).status).toBe('insufficient');
    expect(matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(1), iterations: 10, minTotalReference: 5 }).status).toBe('ok');
  });

  it('결정성: 같은 시드면 CI가 같다', () => {
    const rng = createRng(11);
    const reference = rows('x', Array.from({ length: 20 }, () => 100 + rng.gaussian()));
    const recent = rows('x', Array.from({ length: 20 }, () => 95 + rng.gaussian()));
    const a = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(3) });
    const b = matchedRatio(reference, recent, binOf, valueOf, { rng: createRng(3) });
    expect(a).toEqual(b);
  });
});

describe('scoreConfidence', () => {
  it('설계 §3.1 예시: 18회, 상대 CI 0.48, 완결성 0.98, 방법 일치 → 0.75', () => {
    expect(scoreConfidence({ n: 18, ciWidth: 0.48, dqCompleteness: 0.98, methodsAgree: true })).toBe(0.75);
  });

  it('성질: 표본·품질이 좋아지면 오르고 방법 불일치면 내려간다, 0~1 범위', () => {
    const base = { n: 10, ciWidth: 1, dqCompleteness: 0.9, methodsAgree: null } as const;
    expect(scoreConfidence({ ...base, n: 40 })).toBeGreaterThan(scoreConfidence(base));
    expect(scoreConfidence({ ...base, dqCompleteness: 1 })).toBeGreaterThan(scoreConfidence(base));
    expect(scoreConfidence({ ...base, methodsAgree: false })).toBeLessThan(scoreConfidence(base));
    expect(scoreConfidence({ ...base, ciWidth: null })).toBeGreaterThan(0);
    expect(scoreConfidence({ n: 1000, ciWidth: 0, dqCompleteness: 1, methodsAgree: true })).toBe(1);
    expect(scoreConfidence({ ...base, n: 0 })).toBe(0);
  });

  it('relativeCiWidth', () => {
    expect(relativeCiWidth(-6.25, -7.9, -4.9)).toBeCloseTo(0.48, 12);
    expect(relativeCiWidth(0, -1, 1)).toBeNull();
    expect(relativeCiWidth(1, null, 1)).toBeNull();
  });
});
