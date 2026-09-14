import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '../types';
import { splitReferenceRecent } from './ess-capacity-reference';
import type { CapacitySample } from './ess-capacity-samples';

const sample = (day: number, bin: string, weight = 1): CapacitySample => ({ start: day * MS_PER_DAY, end: day * MS_PER_DAY + 3_600_000, value: 400, weight, bin, completeness: 1 });
const rules = (nowDay: number, extra = {}) => ({ now: nowDay * MS_PER_DAY, recentDays: 21, referencePerBin: 5, maxReferenceSpreadDays: 120, ...extra });

describe('splitReferenceRecent', () => {
  it('bin별 기준: bin마다 가장 이른 5개가 기준, 그 뒤 최근 21일이 최근 (여름 bin도 자기 기준으로 비교)', () => {
    const winter = Array.from({ length: 60 }, (_, d) => sample(d * 2, 'cold'));
    const summer = Array.from({ length: 30 }, (_, d) => sample(150 + d * 2, 'warm'));
    const split = splitReferenceRecent([...winter, ...summer].sort((a, b) => a.start - b.start), rules(210));
    expect(split.mode).toBe('per_bin');
    expect(split.leadBin).toBe('warm');
    const warm = split.bins.find((b) => b.key === 'warm');
    expect(warm).toMatchObject({ nRef: 5, nCur: 10, refFrom: 150 * MS_PER_DAY, excluded: null });
    // 겨울 bin 기준(0~8일)은 여름 bin 기준(150~158일)과 120일 넘게 떨어져 결합에서 뺀다 (최근 표본도 없음)
    expect(split.bins.find((b) => b.key === 'cold')).toMatchObject({ nRef: 5, nCur: 0, excluded: 'reference_spread' });
    expect(split.reference.every((s) => s.bin === 'warm')).toBe(true);
    expect(split.recent).toHaveLength(10);
  });

  it('기준 시점 간격이 120일 이내인 bin은 함께 쓰고, 주 bin은 최근 가중치 합으로 정한다', () => {
    const a = Array.from({ length: 40 }, (_, d) => sample(d * 3, 'a', 1));
    const b = Array.from({ length: 30 }, (_, d) => sample(60 + d * 2, 'b', 5));
    const split = splitReferenceRecent([...a, ...b].sort((x, y) => x.start - y.start), rules(118));
    expect(split.leadBin).toBe('b');
    expect(split.bins.map((bin) => [bin.key, bin.excluded])).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(split.reference).toHaveLength(10);
  });

  it('기준 창(detector_config.reference_window)이 있으면 창 우선: 창 안 전부가 기준, 창 끝 이후 최근 21일이 최근', () => {
    const samples = Array.from({ length: 50 }, (_, d) => sample(d * 2, d % 2 === 0 ? 'x' : 'y'));
    const split = splitReferenceRecent(samples, rules(100, { referenceWindow: { start: 0, end: 20 * MS_PER_DAY } }));
    expect(split.mode).toBe('window');
    expect(split.reference).toHaveLength(10);
    expect(split.recent.every((s) => s.start >= 79 * MS_PER_DAY)).toBe(true);
    expect(split.bins.every((b) => b.excluded === null)).toBe(true);
  });

  it('표본이 기준 수보다 적은 bin은 최근이 없고, 표본이 없으면 주 bin도 없다', () => {
    const split = splitReferenceRecent([sample(1, 'z'), sample(2, 'z')], rules(10));
    expect(split.bins).toEqual([expect.objectContaining({ key: 'z', nRef: 2, nCur: 0 })]);
    expect(split.leadBin).toBeNull();
    expect(splitReferenceRecent([], rules(10))).toMatchObject({ reference: [], recent: [], bins: [], leadBin: null });
  });
});
