// 같은 조건 비교: bin별 중앙값 비율을 최근 표본 수로 가중 결합 + bin 내부 재표집 부트스트랩 CI (설계 §3.1).
import type { RandomSource } from '../types';
import { resample } from './bootstrap';
import { median, quantileSorted, sortedCopy } from './robust';

export interface MatchedRatioOptions {
  /** bin을 쓰려면 기준·최근 모두 이 수 이상 */
  readonly minPerBin?: number;
  /** 사용한 bin의 기준·최근 합계가 각각 이 수 이상이어야 ok */
  readonly minTotal?: number;
  readonly iterations?: number;
  readonly alpha?: number;
  readonly rng: RandomSource;
}

export interface MatchedBin {
  readonly key: string;
  readonly nRef: number;
  readonly nCur: number;
  readonly medRef: number | null;
  readonly medCur: number | null;
  /** medCur / medRef. bin을 쓰지 않았으면 null */
  readonly ratio: number | null;
  readonly used: boolean;
}

interface MatchedBase {
  readonly bins: readonly MatchedBin[];
  readonly nRef: number;
  readonly nCur: number;
}

export interface MatchedRatioOk extends MatchedBase {
  readonly status: 'ok';
  readonly ratio: number;
  readonly ciLow: number;
  readonly ciHigh: number;
}

export interface MatchedRatioInsufficient extends MatchedBase {
  readonly status: 'insufficient';
  readonly ratio: null;
  readonly ciLow: null;
  readonly ciHigh: null;
  readonly reason: string;
}

export type MatchedRatioResult = MatchedRatioOk | MatchedRatioInsufficient;

function groupValues<T>(rows: readonly T[], binKey: (row: T) => string, valueOf: (row: T) => number): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const value = valueOf(row);
    if (!Number.isFinite(value)) continue;
    const key = binKey(row);
    const values = groups.get(key);
    if (values) values.push(value); // 이 함수 안에서 만든 배열만 채운다
    else groups.set(key, [value]);
  }
  return groups;
}

interface UsedBin {
  readonly ref: readonly number[];
  readonly cur: readonly number[];
  readonly weight: number;
}

const combine = (bins: readonly UsedBin[], medianOf: (values: readonly number[]) => number): number =>
  bins.reduce((sum, bin) => sum + bin.weight * (medianOf(bin.cur) / medianOf(bin.ref)), 0);

/**
 * 기준(reference)과 최근(recent) 행을 binKey로 나눠 bin별 중앙값 비율을 구하고, 최근 표본 수(nCur)로 가중 평균한다.
 * CI는 bin마다 기준·최근을 각각 복원추출해 같은 가중치로 다시 결합한 값의 백분위다.
 * 조건(bin당 minPerBin, 합계 minTotal)을 못 채우면 status 'insufficient'.
 */
export function matchedRatio<T>(
  reference: readonly T[],
  recent: readonly T[],
  binKey: (row: T) => string,
  valueKey: (row: T) => number,
  options: MatchedRatioOptions,
): MatchedRatioResult {
  const minPerBin = options.minPerBin ?? 5;
  const minTotal = options.minTotal ?? 15;
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const refGroups = groupValues(reference, binKey, valueKey);
  const curGroups = groupValues(recent, binKey, valueKey);
  const keys = [...new Set([...refGroups.keys(), ...curGroups.keys()])].sort();

  const bins: MatchedBin[] = keys.map((key) => {
    const ref = refGroups.get(key) ?? [];
    const cur = curGroups.get(key) ?? [];
    const medRef = ref.length > 0 ? median(ref) : null;
    const medCur = cur.length > 0 ? median(cur) : null;
    const used = ref.length >= minPerBin && cur.length >= minPerBin && medRef !== null && medRef !== 0;
    return { key, nRef: ref.length, nCur: cur.length, medRef, medCur, ratio: used && medCur !== null && medRef ? medCur / medRef : null, used };
  });
  const usedKeys = bins.filter((b) => b.used).map((b) => b.key);
  const nRef = usedKeys.reduce((sum, key) => sum + (refGroups.get(key)?.length ?? 0), 0);
  const nCur = usedKeys.reduce((sum, key) => sum + (curGroups.get(key)?.length ?? 0), 0);
  if (usedKeys.length === 0 || nRef < minTotal || nCur < minTotal) {
    const reason = `같은 조건 표본 부족: 기준 ${nRef}개·최근 ${nCur}개 (bin당 ${minPerBin}개, 합계 ${minTotal}개 필요)`;
    return { status: 'insufficient', ratio: null, ciLow: null, ciHigh: null, reason, bins, nRef, nCur };
  }

  const usedBins: UsedBin[] = usedKeys.map((key) => {
    const cur = curGroups.get(key) ?? [];
    return { ref: refGroups.get(key) ?? [], cur, weight: cur.length / nCur };
  });
  const ratio = combine(usedBins, median);
  const stats = Array.from({ length: iterations }, () =>
    combine(
      usedBins.map((bin) => ({ ...bin, ref: resample(bin.ref, options.rng), cur: resample(bin.cur, options.rng) })),
      median,
    ),
  );
  const sorted = sortedCopy(stats);
  return { status: 'ok', ratio, ciLow: quantileSorted(sorted, alpha / 2), ciHigh: quantileSorted(sorted, 1 - alpha / 2), bins, nRef, nCur };
}
