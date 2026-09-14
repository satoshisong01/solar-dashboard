// 근거 스냅샷(finding_evidence.snapshot) → 팩 근거 요약 (순수). 분석 데스크의 스냅샷 파서(lib/desk/evidence.ts)로 읽은 뒤
// 리포트 문장에 필요한 수치와 ≤120점 요약 시계열만 남긴다. bin 표·오버레이 곡선 같은 큰 필드는 넣지 않는다.
import { parseCapacityBinKey } from '@/lib/desk/conditions';
import { parseEvidence } from '@/lib/desk/evidence';
import type { CapacityEvidence, CellImbalanceEvidence, CheckView, DqEvidence, PvPeerEvidence, StackEvidence } from '@/lib/desk/evidence-types';
import type { TrendView } from '@/lib/desk/trend';
import { DAYS_PER_MONTH, MS_PER_DAY } from '@/lib/analytics/types';
import { MAX_EVIDENCE_POINTS, type PackCheck, type PackEvidence, type PackSeries } from './pack-types';

const MS_PER_MONTH = DAYS_PER_MONTH * MS_PER_DAY;
const KST_OFFSET_MS = 9 * 3_600_000;

/** 부동소수 잡음 없이 반올림 (팩 해시가 입력의 계산 경로에 흔들리지 않게) */
export const roundTo = (value: number | null, digits: number): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 앞·뒤 점을 남기고 고르게 max개 이하로 줄인다 */
export function downsamplePoints<T>(points: readonly T[], max = MAX_EVIDENCE_POINTS): T[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)] as T);
}

function seriesOf(trend: TrendView | null, yDigits: number): PackSeries | null {
  if (!trend || trend.points.length === 0) return null;
  const xDigits = trend.xKind === 'time' ? 0 : 1;
  const pair = ([x, y]: readonly [number, number]): readonly [number, number] => [roundTo(x, xDigits) ?? x, roundTo(y, yDigits) ?? y];
  return { xKind: trend.xKind, yName: trend.yName, points: downsamplePoints(trend.points).map(pair), line: trend.line ? trend.line.map(pair) : null };
}

const checksOf = (checks: readonly CheckView[]): PackCheck[] => checks.map((c) => ({ label: c.label, status: c.status }));
const perMonth = (perMs: number | null): number | null => roundTo(perMs === null ? null : perMs * MS_PER_MONTH, 3);
const rangeOf = (values: readonly number[]): { low: number; high: number } | null => (values.length === 0 ? null : { low: Math.min(...values), high: Math.max(...values) });

function capacity(e: CapacityEvidence, levels: EffectLevels): PackEvidence {
  const used = e.bins.filter((b) => b.used);
  const parsed = used.map((b) => parseCapacityBinKey(b.key));
  const cRates = rangeOf(parsed.flatMap((p) => (p.cRate === null ? [] : [p.cRate])));
  const temps = rangeOf(parsed.flatMap((p) => (p.tempC === null ? [] : [p.tempC])));
  const hours = (ah: number | null) => (ah === null || e.referenceCurrentA === null || !(e.referenceCurrentA > 0) ? null : ah / e.referenceCurrentA);
  return {
    kind: 'capacity',
    metric: e.metric,
    nRef: used.reduce((sum, b) => sum + b.nRef, 0),
    nCur: used.reduce((sum, b) => sum + b.nCur, 0),
    cRateLow: roundTo(cRates?.low ?? null, 3),
    cRateHigh: roundTo(cRates ? cRates.high + e.widths.cRate : null, 3),
    tempLowC: roundTo(temps?.low ?? null, 1),
    tempHighC: roundTo(temps ? temps.high + e.widths.tempC : null, 1),
    anchorSocMaxPct: e.rules.anchorSocMaxPct,
    minCcSocSpanPct: e.rules.minCcSocSpanPct,
    minSocSpanPct: e.rules.minSocSpanPct,
    restMinutes: e.rules.restMinutes,
    minDeltaSocRestPct: e.rules.minDeltaSocRestPct,
    cautions: [...e.cautions],
    referenceCurrentA: roundTo(e.referenceCurrentA, 1),
    baselineHours: roundTo(hours(levels.baseline), 4),
    currentHours: roundTo(hours(levels.current), 4),
    slopePerMonth: perMonth(e.trend?.slope ?? null),
    slopeCiLow: perMonth(e.trend?.ciLow ?? null),
    slopeCiHigh: perMonth(e.trend?.ciHigh ?? null),
    sohTargetPct: e.sohTarget?.pct ?? null,
    sohTargetDate: e.sohTarget?.projection?.kind === 'date' ? e.sohTarget.projection.estimate : null,
    sohProjectionPendingDays: e.sohTarget?.projection?.kind === 'pending' ? e.sohTarget.projection.spanDays : null,
    series: seriesOf(e.trend, 3),
    checks: checksOf(e.checks),
  };
}

function stack(e: StackEvidence): PackEvidence {
  const line = e.trend?.line ?? null;
  const first = line?.[0] ?? null;
  const last = line?.[line.length - 1] ?? null;
  const perHourUv = (mvPerH: number | null) => roundTo(mvPerH === null ? null : mvPerH * 1000, 3);
  return {
    kind: 'stack',
    slopeBasis: e.slopeBasis,
    fullSlopeUvPerH: roundTo(e.fullSlopeUvPerH, 3),
    segments: e.bins.reduce((sum, b) => sum + b.n, 0),
    binCount: e.bins.length,
    breakInHours: e.breakInHours,
    opHoursFirst: roundTo(first?.[0] ?? null, 0),
    opHoursLast: roundTo(last?.[0] ?? null, 0),
    opHoursSpan: first && last ? roundTo(last[0] - first[0], 0) : null,
    deltaMv: first && last ? roundTo(Math.abs(last[1] - first[1]), 2) : null,
    slopeUvPerH: perHourUv(e.trend?.slope ?? null),
    slopeCiLow: perHourUv(e.trend?.ciLow ?? null),
    slopeCiHigh: perHourUv(e.trend?.ciHigh ?? null),
    series: seriesOf(e.trend, 3),
    checks: checksOf(e.checks),
  };
}

function cellImbalance(e: CellImbalanceEvidence): PackEvidence {
  const xs = e.trend?.points.map(([x]) => x) ?? [];
  return {
    kind: 'cell_imbalance',
    source: e.source === 'rest' ? 'rest' : 'charge_end',
    nRef: e.reference.n,
    nCur: e.recent.n,
    slopeMvPerMonth: perMonth(e.trend?.slope ?? null),
    slopeCiLow: perMonth(e.trend?.ciLow ?? null),
    slopeCiHigh: perMonth(e.trend?.ciHigh ?? null),
    peerCount: e.peers.values.length,
    peerZ: roundTo(e.peers.modifiedZ, 2),
    spanDays: xs.length < 2 ? null : roundTo((Math.max(...xs) - Math.min(...xs)) / MS_PER_DAY, 1),
    series: seriesOf(e.trend, 2),
  };
}

function pvPeer(e: PvPeerEvidence): PackEvidence {
  const points = e.days.flatMap((d) => (d.deviationPct === null ? [] : [[Date.parse(`${d.day}T00:00:00Z`) - KST_OFFSET_MS, roundTo(d.deviationPct, 2) ?? 0] as const]));
  return {
    kind: 'pv_peer',
    days: e.days.length,
    flaggedDays: e.days.filter((d) => d.flagged).length,
    peers: Math.max(0, ...e.days.map((d) => d.peers ?? 0)),
    excludedDays: e.excludedDays ?? 0,
    series: points.length === 0 ? null : { xKind: 'time', yName: '동종 중앙값 대비 편차 (%)', points: downsamplePoints(points), line: null },
  };
}

function dq(e: DqEvidence): PackEvidence {
  const completeness = e.points.flatMap((p) => (p.completeness === null ? [] : [p.completeness * 100]));
  const gaps = e.points.flatMap((p) => (p.gapHours === null ? [] : [p.gapHours]));
  const flats = e.points.flatMap((p) => (p.longestFlatlineHours === null ? [] : [p.longestFlatlineHours]));
  return {
    kind: 'dq',
    pointCount: e.points.length,
    gapPoints: e.gapPoints ?? 0,
    flatlinePoints: e.flatlinePoints ?? 0,
    worstCompletenessPct: completeness.length === 0 ? null : roundTo(Math.min(...completeness), 1),
    longestGapHours: gaps.length === 0 ? null : roundTo(Math.max(...gaps), 1),
    longestFlatlineHours: flats.length === 0 ? null : roundTo(Math.max(...flats), 1),
  };
}

/** finding.effect의 기준·현재 수준 (용량 감소는 Ah — 환산 충전시간 계산에 쓴다) */
export interface EffectLevels {
  readonly baseline: number | null;
  readonly current: number | null;
}

/** 스냅샷 jsonb → 팩 근거 요약. 모르는 형식이면 unknown */
export function summarizeEvidence(snapshot: unknown, levels: EffectLevels): PackEvidence {
  const evidence = parseEvidence(snapshot);
  switch (evidence.kind) {
    case 'capacity':
      return capacity(evidence, levels);
    case 'stack':
      return stack(evidence);
    case 'cell_imbalance':
      return cellImbalance(evidence);
    case 'pv_peer':
      return pvPeer(evidence);
    case 'dq':
      return dq(evidence);
    default:
      return { kind: 'unknown' };
  }
}

/** 요약 시계열 전체 점 수 (팩에 원시 시계열이 들어가지 않았는지 확인용) */
export function evidencePointCount(evidence: PackEvidence): number {
  return 'series' in evidence && evidence.series ? evidence.series.points.length : 0;
}
