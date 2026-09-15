// ess.capacity_fade 기준·최근 표본 나누기 (순수).
// 1) detector_config.reference_window가 있으면 그 창 안 표본이 기준, 창 끝 이후 최근 recentDays일이 최근 (창 우선).
// 2) 없으면 bin별 기준(per-bin reference): 기준선 재설정 이후 각 조건 bin마다 가장 이른 referencePerBin개 표본이 그 bin의 기준,
//    그 bin의 기준 이후이면서 최근 recentDays일 안의 표본이 최근이다. 첫 N 세션을 전체 기준으로 쓰면 한 계절만 덮어
//    다른 계절(온도·전류가 다른 bin)은 기준이 없어 판정할 수 없던 문제를 푼다.
// 기준 시점 간격 규칙: bin마다 기준 시점(기준 표본 시작 시각 중앙값)이 다르므로, 최근 가중치가 가장 큰 bin(주 bin)의 기준 시점에서
//    maxReferenceSpreadDays를 넘게 떨어진 bin은 결합에서 제외한다 (가중치를 낮추는 대신 제외 — 서로 다른 기간의 감소량을 섞지 않기 위해).
//    제외한 bin도 근거에 기준 기간과 제외 이유를 남긴다.
import { median } from '../stats/robust';
import { MS_PER_DAY, type TimeWindow } from '../types';
import type { CapacitySample } from './ess-capacity-samples';

export interface ReferenceRules {
  readonly now: number;
  readonly recentDays: number;
  readonly referencePerBin: number;
  readonly maxReferenceSpreadDays: number;
  readonly referenceWindow?: TimeWindow;
}

export interface BinReference {
  readonly key: string;
  readonly nRef: number;
  readonly nCur: number;
  readonly refFrom: number | null;
  readonly refTo: number | null;
  readonly curFrom: number | null;
  readonly curTo: number | null;
  /** 기준 표본 시작 시각 중앙값 */
  readonly refTime: number | null;
  /** 결합에서 뺀 이유 (없으면 null) */
  readonly excluded: 'reference_spread' | null;
}

export interface ReferenceSplit<S extends CapacitySample = CapacitySample> {
  readonly mode: 'per_bin' | 'window';
  readonly reference: readonly S[];
  readonly recent: readonly S[];
  readonly bins: readonly BinReference[];
  /** 주 bin (최근 가중치 합이 가장 큰 bin). 최근 표본이 없으면 null */
  readonly leadBin: string | null;
}

function groupByBin<S extends CapacitySample>(samples: readonly S[]): Map<string, S[]> {
  const groups = new Map<string, S[]>();
  for (const s of samples) {
    const list = groups.get(s.bin);
    if (list) list.push(s); // 이 함수 안에서 만든 배열만 채운다
    else groups.set(s.bin, [s]);
  }
  return groups;
}

const span = (items: readonly CapacitySample[]) => ({ from: items[0]?.start ?? null, to: items.length === 0 ? null : Math.max(...items.map((s) => s.end)) });
const weightOf = (items: readonly CapacitySample[]): number => items.reduce((sum, s) => sum + s.weight, 0);

function binReference(key: string, ref: readonly CapacitySample[], cur: readonly CapacitySample[]): BinReference {
  const r = span(ref);
  const c = span(cur);
  return { key, nRef: ref.length, nCur: cur.length, refFrom: r.from, refTo: r.to, curFrom: c.from, curTo: c.to, refTime: ref.length === 0 ? null : median(ref.map((s) => s.start)), excluded: null };
}

function leadOf(groups: ReadonlyMap<string, { cur: readonly CapacitySample[] }>): string | null {
  const ranked = [...groups.entries()].filter(([, g]) => g.cur.length > 0).sort((a, b) => weightOf(b[1].cur) - weightOf(a[1].cur) || b[1].cur.length - a[1].cur.length || (a[0] < b[0] ? -1 : 1));
  return ranked[0]?.[0] ?? null;
}

/** samples는 방식 하나의 유효 표본 (기준선 재설정 이후·분석 시각 이전), 시작 시각 오름차순. 표본 타입은 CapacitySample을 확장해도 된다 (P3 같은 조건 비교) */
export function splitReferenceRecent<S extends CapacitySample>(samples: readonly S[], rules: ReferenceRules): ReferenceSplit<S> {
  const recentFrom = rules.now - rules.recentDays * MS_PER_DAY;
  const window = rules.referenceWindow;
  if (window) {
    const reference = samples.filter((s) => s.start >= window.start && s.start < window.end);
    const recent = samples.filter((s) => s.start >= Math.max(window.end, recentFrom));
    const groups = new Map([...new Set([...reference, ...recent].map((s) => s.bin))].sort().map((key) => [key, { ref: reference.filter((s) => s.bin === key), cur: recent.filter((s) => s.bin === key) }]));
    return { mode: 'window', reference, recent, bins: [...groups.entries()].map(([key, g]) => binReference(key, g.ref, g.cur)), leadBin: leadOf(groups) };
  }
  const groups = new Map(
    [...groupByBin(samples).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, list]) => {
      const ref = list.slice(0, rules.referencePerBin);
      const refEnd = ref[ref.length - 1]?.start ?? Infinity;
      return [key, { ref, cur: list.slice(rules.referencePerBin).filter((s) => s.start > refEnd && s.start >= recentFrom) }] as const;
    }),
  );
  const leadBin = leadOf(groups);
  const leadTime = leadBin === null ? null : median((groups.get(leadBin)?.ref ?? []).map((s) => s.start));
  const maxSpreadMs = rules.maxReferenceSpreadDays * MS_PER_DAY;
  const bins = [...groups.entries()].map(([key, g]) => {
    const view = binReference(key, g.ref, g.cur);
    const tooFar = leadTime !== null && view.refTime !== null && Math.abs(view.refTime - leadTime) > maxSpreadMs;
    return tooFar ? { ...view, excluded: 'reference_spread' as const } : view;
  });
  const kept = new Set(bins.filter((b) => b.excluded === null).map((b) => b.key));
  return {
    mode: 'per_bin',
    reference: [...groups.entries()].flatMap(([key, g]) => (kept.has(key) ? g.ref : [])),
    recent: [...groups.entries()].flatMap(([key, g]) => (kept.has(key) ? g.cur : [])),
    bins,
    leadBin,
  };
}
