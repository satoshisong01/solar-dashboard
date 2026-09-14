// dq.gap_flatline 메모리 모드 평가 (순수): 저장값 수준 결측(dq.sample_loss)·고착(dq.stuck_sensor) 주입을 메모리 시계열에서 요약해 탐지한다.
// DB 경로(lib/analysis/dq-summary.ts)와 같은 요약 규칙(lib/analytics/dq/summary.ts)을 쓴다. 전송 계층(단절 후 백필·지연·시계 오차)은 재현하지 않는다.
// 준비 단계에서 1년치 원시를 포인트별로 압축(샘플 격자·결측 인덱스 구간·기준 이상 고착 구간)해 두고, 점검 시각마다 [now − 7일, now) 창으로 요약한다.
//   창 요약: 시간별 받은 샘플 수 = 격자 샘플 수 − 결측 샘플 수, 고착 구간 = 전체 고착 구간을 창 안 샘플 격자로 자른 뒤 기준 이상만
//   (SQL은 창 안 샘플만으로 구간을 만들므로 같은 결과. 기준 미만 구간은 잘라도 기준을 넘지 못하므로 준비 단계에서 버린다)
import { METRIC_DEF_BY_KEY } from '@/db/seed/catalog';
import { dqGapFlatline } from '@/lib/analytics/detectors/dq-gap-flatline';
import type { CandidateFinding } from '@/lib/analytics/detectors/types';
import { flatRunsFromSamples, summarizePoints, type DqPointMeta, type FlatRun, type HourCount } from '@/lib/analytics/dq/summary';
import { MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '@/lib/analytics/types';
import { readingKey } from '../plant-types';
import type { MemorySeries } from '../memory';
import { deriveRng } from '../rng';
import type { EvalSite } from './assets';

/** 점검 창 길이: 주 단위 점검과 같다 */
export const DQ_WINDOW_DAYS = 7;

export interface PreparedDqPoint {
  readonly meta: DqPointMeta;
  readonly firstTs: number;
  readonly periodMs: number;
  readonly count: number;
  /** 결측 샘플 인덱스 구간 [from, to) */
  readonly lost: readonly (readonly [number, number])[];
  /** 실행 전체에서 기준 이상인 고착 구간 */
  readonly flatRuns: readonly FlatRun[];
}

export interface PreparedDq {
  readonly points: readonly PreparedDqPoint[];
}

function lostRanges(values: Float64Array): [number, number][] {
  const ranges: [number, number][] = [];
  let from = -1;
  for (let i = 0; i <= values.length; i += 1) {
    const lost = i < values.length && Number.isNaN(values[i] as number);
    if (lost && from < 0) from = i;
    if (!lost && from >= 0) {
      ranges.push([from, i]);
      from = -1;
    }
  }
  return ranges;
}

/** 메모리 시계열 → 평가용 압축 요약. 포인트 id는 시계열 키 순서로 정한 결정적 값이다 */
export function prepareDq(site: EvalSite, series: ReadonlyMap<string, MemorySeries>, window: TimeWindow): PreparedDq {
  const ordered = [...series.values()].filter((s) => s.siteCode === site.site.code).sort((a, b) => (a.key < b.key ? -1 : 1));
  const points = ordered.flatMap((s, i): PreparedDqPoint[] => {
    const asset = site.byPath.get(s.assetPath);
    const firstTs = s.ts[0];
    if (!asset || firstTs === undefined) return [];
    const meta: DqPointMeta = { pointId: i + 1, assetId: asset.id, metricKey: readingKey(s.metricKey, s.qualifier), sourceKey: s.sourceKey, periodS: s.periodS, flatlineMaxS: METRIC_DEF_BY_KEY.get(s.metricKey)?.flatlineMaxS ?? null };
    return [{ meta, firstTs, periodMs: s.periodS * 1000, count: s.ts.length, lost: lostRanges(s.value), flatRuns: flatRunsFromSamples(meta, s.ts, s.value, window) }];
  });
  return { points };
}

function hourCountsOf(point: PreparedDqPoint, window: TimeWindow): HourCount[] {
  const indexAtOrAfter = (t: number): number => Math.min(point.count, Math.max(0, Math.ceil((t - point.firstTs) / point.periodMs)));
  const lostBetween = (from: number, to: number): number => point.lost.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  const firstHour = Math.ceil(window.start / MS_PER_HOUR) * MS_PER_HOUR;
  const hours = Math.max(0, Math.floor((window.end - firstHour) / MS_PER_HOUR));
  return Array.from({ length: hours }, (_, h) => {
    const hourStart = firstHour + h * MS_PER_HOUR;
    const from = indexAtOrAfter(hourStart);
    const to = indexAtOrAfter(hourStart + MS_PER_HOUR);
    return { pointId: point.meta.pointId, hourStart, n: to - from - lostBetween(from, to) };
  });
}

function clippedRuns(point: PreparedDqPoint, window: TimeWindow): FlatRun[] {
  const minMs = (point.meta.flatlineMaxS ?? Infinity) * 1000;
  const firstSampleIn = point.firstTs + Math.ceil((window.start - point.firstTs) / point.periodMs) * point.periodMs;
  const lastSampleEnd = point.firstTs + Math.floor((window.end - 1 - point.firstTs) / point.periodMs) * point.periodMs + point.periodMs;
  return point.flatRuns.flatMap((run) => {
    const start = Math.max(run.start, firstSampleIn);
    const end = Math.min(run.end, lastSampleEnd);
    return end - start >= minMs ? [{ ...run, start, end }] : [];
  });
}

/** 점검 시각 now의 [now − 7일, now) 데이터 품질 finding (실행 시작 전 부분은 창에서 뺀다) */
export function dqFindingsAt(prepared: PreparedDq, siteId: number, fromMs: number, now: number, seed: number): readonly CandidateFinding[] {
  const window = { start: Math.max(fromMs, now - DQ_WINDOW_DAYS * MS_PER_DAY), end: now };
  if (window.end <= window.start || prepared.points.length === 0) return [];
  const summaries = summarizePoints(
    prepared.points.map((p) => p.meta),
    prepared.points.flatMap((p) => hourCountsOf(p, window)),
    prepared.points.flatMap((p) => clippedRuns(p, window)),
    window,
  );
  const result = dqGapFlatline.detect({ siteId, window, points: summaries }, { now, rng: deriveRng(seed, dqGapFlatline.id, siteId), params: {} });
  return result.status === 'ok' ? result.findings : [];
}

/** 데이터 품질 평가 대상 설비 수 (포인트가 있는 설비) */
export const dqAssetCount = (prepared: PreparedDq): number => new Set(prepared.points.map((p) => p.meta.assetId)).size;
