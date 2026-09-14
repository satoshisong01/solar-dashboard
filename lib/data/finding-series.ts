import 'server-only';
import { kstDayStart, MS_PER_DAY } from '@/lib/analytics/types';
import { db } from '@/lib/db/kysely';
import type { EvidenceView } from '@/lib/desk/evidence-types';
import { getPoints, type PointInfo } from './points';
import { getSeries } from './series';
import { SERIES_LIMITS, type SeriesPayload } from './series-types';

export const FINDING_SERIES_SPANS = Object.freeze({
  '2d': { label: '48시간', ms: 2 * MS_PER_DAY },
  '7d': { label: '7일', ms: 7 * MS_PER_DAY },
  '30d': { label: '30일', ms: 30 * MS_PER_DAY },
});
export type FindingSeriesSpan = keyof typeof FINDING_SERIES_SPANS;

export const isSeriesSpan = (value: string | undefined): value is FindingSeriesSpan => value !== undefined && Object.hasOwn(FINDING_SERIES_SPANS, value);

/** 탐지기별 원시 시계열로 보여 줄 메트릭 (단위 2개 이하) */
const RELATED_METRICS: Readonly<Record<string, readonly string[]>> = {
  'ess.capacity_fade': ['batt.current', 'batt.soc'],
  'ess.cell_imbalance': ['cell.voltage.max', 'cell.voltage.min', 'batt.current'],
  'pv.inverter_peer': ['ac.power', 'ac.power.limit'],
  'el.voltage_rise': ['stack.voltage', 'stack.current'],
  'fc.voltage_decay': ['stack.voltage', 'stack.current'],
};

/** 탐지기별 에피소드 구간 밴드 종류 */
const BAND_EPISODES: Readonly<Record<string, { kind: string; label: string }>> = {
  'ess.capacity_fade': { kind: 'ess.charge', label: '충전 세션' },
  'ess.cell_imbalance': { kind: 'ess.charge', label: '충전 세션' },
  'el.voltage_rise': { kind: 'el.steady_run', label: '정상운전' },
  'fc.voltage_decay': { kind: 'fc.steady_run', label: '정상운전' },
};

const MAX_BANDS = 200;
const MAX_DQ_POINTS = 4;

export const defaultSeriesSpan = (detectorId: string): FindingSeriesSpan => (detectorId === 'pv.inverter_peer' || detectorId === 'dq.gap_flatline' ? '7d' : '2d');

export interface SeriesBand {
  readonly id: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
}

export interface FindingSeries {
  readonly points: readonly PointInfo[];
  readonly payload: SeriesPayload | null;
  readonly bands: readonly SeriesBand[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly bandLabel: string | null;
}

interface SeriesTarget {
  readonly detectorId: string;
  readonly assetId: number | null;
  readonly windowEndMs: number;
  readonly evidence: EvidenceView;
}

async function relatedPoints(target: SeriesTarget): Promise<PointInfo[]> {
  if (target.evidence.kind === 'dq') {
    const ids = target.evidence.points.slice(0, MAX_DQ_POINTS).map((p) => p.pointId);
    return [...(await getPoints({ pointIds: ids }))];
  }
  if (target.assetId === null) return [];
  const metrics = RELATED_METRICS[target.detectorId] ?? [];
  const points = await getPoints({ assetId: target.assetId });
  return metrics.flatMap((metric) => points.filter((p) => p.metricKey === metric && p.qualifier === '').slice(0, 1));
}

async function episodeBands(target: SeriesTarget, fromMs: number, toMs: number): Promise<SeriesBand[]> {
  const spec = BAND_EPISODES[target.detectorId];
  if (!spec || target.assetId === null) return [];
  const rows = await db
    .selectFrom('om.episode')
    .select(['start_ts', 'end_ts'])
    .where('asset_id', '=', target.assetId)
    .where('kind', '=', spec.kind)
    .where('valid', '=', true)
    .where('start_ts', '<', new Date(toMs))
    .where('end_ts', '>', new Date(fromMs))
    .orderBy('start_ts')
    .limit(MAX_BANDS)
    .execute();
  return rows.map((row) => ({ id: `ep-${row.start_ts.getTime()}`, fromMs: row.start_ts.getTime(), toMs: row.end_ts.getTime(), label: spec.label }));
}

function evidenceBands(evidence: EvidenceView, fromMs: number, toMs: number): SeriesBand[] {
  const inRange = (band: SeriesBand) => band.fromMs < toMs && band.toMs > fromMs;
  if (evidence.kind === 'pv_peer') {
    return evidence.days
      .filter((d) => d.flagged)
      .map((d) => {
        const start = kstDayStart(Date.parse(`${d.day}T12:00:00+09:00`));
        return { id: `day-${d.day}`, fromMs: start, toMs: start + MS_PER_DAY, label: '동종 대비 낮은 날' };
      })
      .filter(inRange);
  }
  if (evidence.kind === 'dq') {
    return evidence.points
      .flatMap((p) => [
        ...p.gaps.map((g, i) => ({ id: `gap-${p.pointId}-${i}`, fromMs: g.start, toMs: g.end, label: `결측 ${p.sourceKey}` })),
        ...p.flatlines.map((f, i) => ({ id: `flat-${p.pointId}-${i}`, fromMs: f.start, toMs: f.end, label: `고착 ${p.sourceKey}` })),
      ])
      .filter(inRange)
      .slice(0, MAX_BANDS);
  }
  return [];
}

/** 발견사항 창 끝(지금 이후면 지금)에서 span만큼 앞까지 관련 포인트 원시·롤업과 에피소드 밴드 */
export async function getFindingSeries(target: SeriesTarget, span: FindingSeriesSpan, nowMs: number): Promise<FindingSeries> {
  const toMs = Math.min(target.windowEndMs + 60_000, nowMs);
  const fromMs = toMs - FINDING_SERIES_SPANS[span].ms;
  const points = await relatedPoints(target);
  const [payload, episodes] = await Promise.all([
    points.length === 0 ? null : getSeries({ pointIds: points.map((p) => p.id), fromMs, toMs, maxPoints: SERIES_LIMITS.defaultMaxPoints }),
    episodeBands(target, fromMs, toMs),
  ]);
  const bands = [...episodes, ...evidenceBands(target.evidence, fromMs, toMs)];
  return { points, payload, bands, fromMs, toMs, bandLabel: bands[0]?.label ?? null };
}
