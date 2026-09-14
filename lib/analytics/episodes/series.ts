// 원시 샘플 도우미: good 필터, 공칭 주기, 시각 조회(이진 탐색), 0차 유지 적분, 완결성, 다운샘플.
import { isGood } from '@/lib/ingest/quality';
import { median } from '../stats/robust';
import { MS_PER_HOUR, type AssetSeries, type Sample, type TimeWindow } from '../types';
import type { EpisodeDq } from './types';

/** good 품질이고 값이 있는 샘플 */
export interface TimedValue {
  readonly ts: number;
  readonly value: number;
}

export const sortSamples = (samples: readonly Sample[]): Sample[] => [...samples].sort((a, b) => a.ts - b.ts);

/** 메트릭의 good 샘플 (ts 오름차순 가정). 메트릭이 없으면 빈 배열 */
export function goodPoints(series: AssetSeries, metric: string): TimedValue[] {
  const points: TimedValue[] = []; // 수십만 샘플이라 flatMap 대신 새 배열을 직접 채운다
  for (const s of series[metric] ?? []) {
    if (s.value !== null && Number.isFinite(s.value) && isGood(s.quality)) points.push({ ts: s.ts, value: s.value });
  }
  return points;
}

/** 이웃 샘플 간격의 중앙값. 샘플이 2개 미만이면 fallback */
export function nominalPeriodMs(points: readonly { readonly ts: number }[], fallbackMs: number): number {
  if (points.length < 2) return fallbackMs;
  const gaps = points.slice(1).map((p, i) => p.ts - (points[i] as { ts: number }).ts).filter((g) => g > 0);
  return gaps.length > 0 ? median(gaps) : fallbackMs;
}

/** ts 이하인 마지막 인덱스 (없으면 -1) */
function lastIndexAtOrBefore(points: readonly TimedValue[], ts: number): number {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((points[mid] as TimedValue).ts <= ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** ts 이전(포함) toleranceMs 안의 마지막 값 */
export function valueAtOrBefore(points: readonly TimedValue[], ts: number, toleranceMs: number): number | null {
  const point = points[lastIndexAtOrBefore(points, ts)];
  return point && ts - point.ts <= toleranceMs ? point.value : null;
}

/** ts 이후(포함) toleranceMs 안의 첫 값 */
export function valueAtOrAfter(points: readonly TimedValue[], ts: number, toleranceMs: number): number | null {
  const index = lastIndexAtOrBefore(points, ts);
  const exact = points[index];
  if (exact && exact.ts === ts) return exact.value;
  const point = points[index + 1];
  return point && point.ts - ts <= toleranceMs ? point.value : null;
}

/** 가장 가까운 값 (toleranceMs 안) */
export function valueNear(points: readonly TimedValue[], ts: number, toleranceMs: number): number | null {
  const index = lastIndexAtOrBefore(points, ts);
  const candidates = [points[index], points[index + 1]].filter((p): p is TimedValue => p !== undefined && Math.abs(p.ts - ts) <= toleranceMs);
  candidates.sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts));
  return candidates[0]?.value ?? null;
}

/** [start, end) 안의 점 */
export function pointsIn(points: readonly TimedValue[], range: TimeWindow): TimedValue[] {
  const from = lastIndexAtOrBefore(points, range.start - 1) + 1;
  const to = lastIndexAtOrBefore(points, range.end - 1) + 1;
  return points.slice(from, to);
}

/**
 * 0차 유지 적분 [값·h]: 각 점은 다음 점까지(간격이 maxGapMs를 넘으면 공칭 주기만큼) 값을 유지한다. range 밖은 자른다.
 * weight로 점별 값을 바꿀 수 있다 (예: 조건을 만족하면 1 → 시간 [h]).
 */
export function holdIntegral(
  points: readonly TimedValue[],
  range: TimeWindow,
  periodMs: number,
  maxGapMs: number,
  weight: (p: TimedValue) => number = (p) => p.value,
): number {
  const from = lastIndexAtOrBefore(points, range.start - 1) + 1;
  let totalMs = 0;
  for (let i = from; i < points.length; i += 1) {
    const point = points[i] as TimedValue;
    if (point.ts >= range.end) break;
    const next = points[i + 1];
    const step = next && next.ts - point.ts <= maxGapMs ? next.ts - point.ts : periodMs;
    totalMs += weight(point) * (Math.min(point.ts + step, range.end) - point.ts);
  }
  return totalMs / MS_PER_HOUR;
}

/**
 * 느린 메트릭(5분 주기 등)용 구간 적분 [값·h]: 구간 시작 직전 샘플 값을 시작 시각부터 유지해 넣는다.
 * 샘플 간격 허용치는 공칭 주기의 2.5배. 구간에 걸치는 샘플이 없으면 null.
 */
export function rangeIntegral(points: readonly TimedValue[], range: TimeWindow, periodMs: number): number | null {
  const maxGapMs = 2.5 * periodMs;
  const inside = pointsIn(points, range);
  const before = inside[0]?.ts === range.start ? null : valueAtOrBefore(points, range.start, maxGapMs);
  const combined = before === null ? inside : [{ ts: range.start, value: before }, ...inside];
  if (combined.length === 0) return null;
  return holdIntegral(combined, range, periodMs, maxGapMs);
}

export function meanValue(points: readonly TimedValue[]): number | null {
  return points.length === 0 ? null : points.reduce((sum, p) => sum + p.value, 0) / points.length;
}

/** ts 오름차순 원시 샘플에서 ts 이상인 첫 인덱스 */
function lowerBound(samples: readonly Sample[], ts: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((samples[mid] as Sample).ts < ts) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 한 메트릭의 [start, end) 품질: 기대 샘플 수 = 구간 길이 / 공칭 주기 (샘플은 ts 오름차순) */
export function metricDq(samples: readonly Sample[] | undefined, range: TimeWindow, periodMs: number): EpisodeDq {
  const expected = Math.max(1, Math.round((range.end - range.start) / periodMs));
  const all = samples ?? [];
  const inRange = all.slice(lowerBound(all, range.start), lowerBound(all, range.end));
  const present = inRange.filter((s) => s.value !== null).length;
  const good = inRange.filter((s) => s.value !== null && isGood(s.quality)).length;
  return {
    completeness: Math.min(1, good / expected),
    missing_ratio: Math.max(0, expected - present) / expected,
    bad_ratio: Math.min(1, (present - good) / expected),
  };
}

/** 필수 메트릭 여러 개의 품질: 가장 나쁜 값 */
export function worstDq(items: readonly EpisodeDq[]): EpisodeDq {
  if (items.length === 0) return { completeness: 0, missing_ratio: 1, bad_ratio: 0 };
  return {
    completeness: Math.min(...items.map((d) => d.completeness)),
    missing_ratio: Math.max(...items.map((d) => d.missing_ratio)),
    bad_ratio: Math.max(...items.map((d) => d.bad_ratio)),
  };
}

/** 처음·끝을 포함해 고르게 maxPoints개 이하로 줄인다 */
export function downsample<T>(items: readonly T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return [...items];
  if (maxPoints < 2) return items.slice(0, Math.max(0, maxPoints));
  const step = (items.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => items[Math.round(i * step)] as T);
}

/** value를 width 폭 bin의 하한으로 내린다 (부동소수 잡음 제거). 예: binFloor(0.125, 0.05) = 0.1 */
export function binFloor(value: number, width: number): number {
  const bin = Math.floor(value / width + 1e-9) * width;
  return Math.round(bin * 1e6) / 1e6;
}

export const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

export const roundOrNull = (value: number | null, decimals: number): number | null => (value === null || !Number.isFinite(value) ? null : round(value, decimals));
