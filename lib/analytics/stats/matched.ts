// 같은 조건 비교: bin별 중앙값 비율을 최근 표본 가중치로 결합 + bin 내부 재표집 부트스트랩 CI (설계 §3.1).
import type { RandomSource } from '../types';
import { resample } from './bootstrap';
import { quantileSorted, sortedCopy, weightedMedian } from './robust';

export interface MatchedRatioOptions<T = unknown> {
  /** bin을 쓰려면 기준·최근 모두 이 수 이상 */
  readonly minPerBin?: number;
  /** 사용한 bin의 기준·최근 합계가 각각 이 수 이상이어야 ok */
  readonly minTotal?: number;
  /** 기준 합계 하한만 따로 줄 때 (bin마다 기준을 따로 고르는 경우). 생략하면 minTotal */
  readonly minTotalReference?: number;
  readonly iterations?: number;
  readonly alpha?: number;
  readonly rng: RandomSource;
  /**
   * 표본 가중치 (예: 추정 불확실도의 역분산). 주면 bin 통계량은 가중 중앙값, bin 결합 가중치는 최근 표본 가중치 합의 비율이다.
   * 생략하면 모든 표본 가중치 1 → 보통 중앙값과 최근 표본 수 비율 (기존 방식과 같다).
   */
  readonly weightKey?: (row: T) => number;
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
  /** 결합 가중치 (쓴 bin만, 합 1). 쓰지 않았으면 0 */
  readonly weight: number;
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

/** 표본 하나: 값과 가중치 */
interface Weighted {
  readonly value: number;
  readonly weight: number;
}

function groupValues<T>(rows: readonly T[], binKey: (row: T) => string, valueOf: (row: T) => number, weightOf: (row: T) => number): Map<string, Weighted[]> {
  const groups = new Map<string, Weighted[]>();
  for (const row of rows) {
    const value = valueOf(row);
    const weight = weightOf(row);
    if (!Number.isFinite(value) || !(weight > 0) || !Number.isFinite(weight)) continue;
    const key = binKey(row);
    const values = groups.get(key);
    if (values) values.push({ value, weight }); // 이 함수 안에서 만든 배열만 채운다
    else groups.set(key, [{ value, weight }]);
  }
  return groups;
}

const statOf = (items: readonly Weighted[]): number => weightedMedian(items.map((i) => i.value), items.map((i) => i.weight));
const weightSum = (items: readonly Weighted[]): number => items.reduce((sum, i) => sum + i.weight, 0);

interface UsedBin {
  readonly ref: readonly Weighted[];
  readonly cur: readonly Weighted[];
  readonly weight: number;
}

const combine = (bins: readonly UsedBin[]): number => bins.reduce((sum, bin) => sum + bin.weight * (statOf(bin.cur) / statOf(bin.ref)), 0);

/**
 * 기준(reference)과 최근(recent) 행을 binKey로 나눠 bin별 (가중) 중앙값 비율을 구하고, 최근 표본 가중치 합 비율로 결합한다.
 * CI는 bin마다 기준·최근을 각각 (값, 가중치) 쌍으로 복원추출해 결합 가중치를 고정한 채 다시 결합한 값의 백분위다.
 * 조건(bin당 minPerBin, 합계 minTotal — 개수 기준)을 못 채우면 status 'insufficient'.
 */
export function matchedRatio<T>(
  reference: readonly T[],
  recent: readonly T[],
  binKey: (row: T) => string,
  valueKey: (row: T) => number,
  options: MatchedRatioOptions<T>,
): MatchedRatioResult {
  const minPerBin = options.minPerBin ?? 5;
  const minTotal = options.minTotal ?? 15;
  const minTotalReference = options.minTotalReference ?? minTotal;
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const weightOf = options.weightKey ?? (() => 1);
  const refGroups = groupValues(reference, binKey, valueKey, weightOf);
  const curGroups = groupValues(recent, binKey, valueKey, weightOf);
  const keys = [...new Set([...refGroups.keys(), ...curGroups.keys()])].sort();

  const usable = (key: string): boolean => {
    const ref = refGroups.get(key) ?? [];
    const cur = curGroups.get(key) ?? [];
    return ref.length >= minPerBin && cur.length >= minPerBin && statOf(ref) !== 0;
  };
  const usedKeys = keys.filter(usable);
  const nRef = usedKeys.reduce((sum, key) => sum + (refGroups.get(key)?.length ?? 0), 0);
  const nCur = usedKeys.reduce((sum, key) => sum + (curGroups.get(key)?.length ?? 0), 0);
  const curWeightTotal = usedKeys.reduce((sum, key) => sum + weightSum(curGroups.get(key) ?? []), 0);
  const bins: MatchedBin[] = keys.map((key) => {
    const ref = refGroups.get(key) ?? [];
    const cur = curGroups.get(key) ?? [];
    const medRef = ref.length > 0 ? statOf(ref) : null;
    const medCur = cur.length > 0 ? statOf(cur) : null;
    const used = usedKeys.includes(key);
    return { key, nRef: ref.length, nCur: cur.length, medRef, medCur, ratio: used && medCur !== null && medRef ? medCur / medRef : null, used, weight: used && curWeightTotal > 0 ? weightSum(cur) / curWeightTotal : 0 };
  });
  if (usedKeys.length === 0 || nRef < minTotalReference || nCur < minTotal) {
    const reason = `같은 조건 표본 부족: 기준 ${nRef}개·최근 ${nCur}개 (bin당 ${minPerBin}개, 합계 기준 ${minTotalReference}개·최근 ${minTotal}개 필요)`;
    return { status: 'insufficient', ratio: null, ciLow: null, ciHigh: null, reason, bins, nRef, nCur };
  }

  const usedBins: UsedBin[] = bins.filter((b) => b.used).map((b) => ({ ref: refGroups.get(b.key) ?? [], cur: curGroups.get(b.key) ?? [], weight: b.weight }));
  const ratio = combine(usedBins);
  const stats = Array.from({ length: iterations }, () => combine(usedBins.map((bin) => ({ ...bin, ref: resample(bin.ref, options.rng), cur: resample(bin.cur, options.rng) }))));
  const sorted = sortedCopy(stats);
  return { status: 'ok', ratio, ciLow: quantileSorted(sorted, alpha / 2), ciHigh: quantileSorted(sorted, 1 - alpha / 2), bins, nRef, nCur };
}
