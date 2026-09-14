// 탐지기 공용 도우미: 결과 생성, 심각도, 한국어 수치 표기, 일 중앙값 축약, 추세 요약.
import { kstDateString, kstDayStart } from '../types';
import { cusum, standardize, type CusumDirection } from '../stats/change';
import { median } from '../stats/robust';
import { mannKendall, theilSen, type TheilSenResult } from '../stats/trend';
import type { DetectorResult, Severity } from './types';

export const insufficient = (reason: string): DetectorResult => ({ status: 'insufficient', reason });

export const withDefaults = <P extends object>(defaults: P, overrides: Partial<P>): P => ({ ...defaults, ...overrides });

/** 크기(양수)가 큰 임계부터 비교: thresholds = [[40, 4], [20, 3], [10, 2]] → 25 → 3. 어느 것도 못 넘으면 null */
export function severityByMagnitude(magnitude: number, thresholds: readonly (readonly [threshold: number, severity: Severity])[]): Severity | null {
  const sorted = [...thresholds].sort((a, b) => b[0] - a[0]);
  return sorted.find(([threshold]) => magnitude >= threshold)?.[1] ?? null;
}

const toFixedSafe = (value: number, decimals: number): string => {
  const text = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
};

/** 부호 붙은 고정 소수: +1.2 / -6.3 / 0.0 */
export function signed(value: number, decimals = 1): string {
  const text = toFixedSafe(value, decimals);
  return value > 0 && Number(text) !== 0 ? `+${text}` : text;
}

/** 천 단위 구분 고정 소수: 1,234.5 */
export function fixed(value: number, decimals = 1): string {
  const [integer = '0', fraction] = toFixedSafe(value, decimals).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** 시간 → '8시간 0분' */
export function hoursKo(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  return `${Math.floor(totalMinutes / 60)}시간 ${totalMinutes % 60}분`;
}

export const dateKo = (ts: number): string => kstDateString(ts);

export interface TimedNumber {
  readonly ts: number;
  readonly value: number;
}

/** KST 일별 중앙값 (Theil–Sen 쌍 수를 줄이고 하루 안 자기상관을 없앤다) */
export function dailyMedians(points: readonly TimedNumber[]): TimedNumber[] {
  const groups = new Map<number, number[]>();
  for (const p of points) {
    const day = kstDayStart(p.ts);
    const values = groups.get(day);
    if (values) values.push(p.value);
    else groups.set(day, [p.value]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([day, values]) => ({ ts: day, value: median(values) }));
}

/** x 기준으로 maxGroups개 이하의 등간격 구간 중앙값 (운전시간 축 등) */
export function groupedMedians(xs: readonly number[], ys: readonly number[], maxGroups: number): { xs: number[]; ys: number[] } {
  if (xs.length <= maxGroups) return { xs: [...xs], ys: [...ys] };
  const min = Math.min(...xs);
  const width = (Math.max(...xs) - min) / maxGroups || 1;
  const groups = new Map<number, { xs: number[]; ys: number[] }>();
  xs.forEach((x, i) => {
    const key = Math.min(maxGroups - 1, Math.floor((x - min) / width));
    const group = groups.get(key) ?? { xs: [], ys: [] };
    group.xs.push(x);
    group.ys.push(ys[i] as number);
    groups.set(key, group);
  });
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  return { xs: ordered.map((g) => median(g.xs)), ys: ordered.map((g) => median(g.ys)) };
}

export interface TrendSummary {
  readonly fit: TheilSenResult;
  readonly mkPValue: number;
  readonly mkTau: number;
  /** CUSUM 경보 인덱스·시작 인덱스 (입력 순서 기준) */
  readonly changeStartIndex: number | null;
  readonly alarmIndex: number | null;
}

/**
 * Theil–Sen + Mann–Kendall + CUSUM을 한 번에. CUSUM은 앞쪽 referenceCount개 값의 중앙값·σ로 표준화한다.
 * x가 서로 다른 점이 3개 미만이면 null.
 */
export function summarizeTrend(xs: readonly number[], ys: readonly number[], options: { referenceCount: number; sigmaFloor: number; direction: CusumDirection; k: number; h: number }): TrendSummary | null {
  if (new Set(xs).size < 3) return null;
  const fit = theilSen(xs, ys);
  const mk = mannKendall(ys);
  const reference = ys.slice(0, Math.max(3, options.referenceCount));
  const change = cusum(standardize(ys, reference, options.sigmaFloor), { k: options.k, h: options.h, direction: options.direction });
  return { fit, mkPValue: mk.pValue, mkTau: mk.tau, changeStartIndex: change.changeStartIndex, alarmIndex: change.alarmIndex };
}

/** 소수 자릿수 반올림 (-0 제거) — 근거 스냅샷 크기를 줄인다 */
export function r(value: number | null, decimals = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
