// 저장용기 정지 보유 구간 (tank.static_leak): 원시를 전부 읽지 않는다.
//   추출: 1시간 롤업에서 유입·유출이 멈춘 시간 후보(tankHoldWindows) → 그 창만 원시(용기 P·T + 흐름 신호)를 읽어 tank.hold 에피소드 추출·저장
//   탐지: 저장된 에피소드에서 탐지기와 같은 규칙(selectHolds)으로 기준·최근 구간만 골라 그 구간의 원시 P·T만 읽는다
import type { Kysely } from 'kysely';
import { pressureCrossChecks, type PressureCrossCheck } from '@/lib/analytics/detectors/tank-peer-pressure';
import { selectHolds, tankStaticLeak } from '@/lib/analytics/detectors/tank-static-leak';
import { goodPoints, type TimedValue } from '@/lib/analytics/episodes/series';
import { tankHoldPoints, type TankHoldEpisode, type TankHoldPoint } from '@/lib/analytics/episodes/tank-hold';
import { resolveDetectorConfig } from '@/lib/analytics/pipeline/config';
import { extractAssetEpisodes } from '@/lib/analytics/pipeline/extract';
import { tankHoldWindows, TANK_FLOW_SIGNALS, TANK_WINDOW_PADDING_MS } from '@/lib/analytics/pipeline/load-plans';
import type { SnapshotIndex } from '@/lib/analytics/pipeline/snapshot';
import { seriesRequests } from '@/lib/analytics/pipeline/sources';
import type { PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { MS_PER_MINUTE, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import type { PointRow } from './catalog';
import { loadAssetSeries, loadHourly } from './series';

/** 원시 P·T 조회 앞뒤 여유 (구간 경계 샘플의 온도 짝을 찾는 허용 시차보다 길게) */
const POINT_MARGIN_MS = 10 * MS_PER_MINUTE;

export interface TankHoldExtraction {
  readonly episodes: StoredEpisode[];
  /** 원시를 읽은 창 수·총 길이 [h] (실행 통계) */
  readonly windows: number;
  readonly rawHours: number;
}

/** [window) tank.hold 에피소드 (시작이 창 안인 것만). 흐름 신호 롤업으로 고른 창만 원시를 읽는다 */
export async function extractTankHoldsWindowed(db: Kysely<DB>, tank: PipelineAsset, assets: readonly PipelineAsset[], points: readonly PointRow[], window: TimeWindow): Promise<TankHoldExtraction> {
  const requests = seriesRequests(tank, assets);
  const signalKeys = new Set(TANK_FLOW_SIGNALS.map((s) => s.metricKey));
  const signalPoints = requests.flatMap((r) => (signalKeys.has(r.metricKey) ? points.filter((p) => p.assetId === r.assetId && p.metricKey === r.metricKey) : []));
  const hours = await loadHourly(db, signalPoints, { start: window.start - TANK_WINDOW_PADDING_MS, end: window.end });
  const windows = tankHoldWindows(hours, new Set(signalPoints.map((p) => p.metricKey)), { start: window.start - TANK_WINDOW_PADDING_MS, end: window.end });
  const episodes: StoredEpisode[] = []; // 창마다 추출한 에피소드를 모으는 누적 목록 (이 함수 안에서만 채운다)
  for (const w of windows) {
    const series = await loadAssetSeries(db, requests, points, w);
    episodes.push(...extractAssetEpisodes(tank, series, w).filter((e) => e.start >= window.start && e.start < window.end));
  }
  return { episodes, windows: windows.length, rawHours: windows.reduce((sum, w) => sum + (w.end - w.start) / 3_600_000, 0) };
}

export interface TankHoldInputs {
  /** 용기 id → 구간 시작 → 압력·온도 짝 */
  readonly points: Map<number, Map<number, TankHoldPoint[]>>;
  /** 용기 id → 최근 구간별 비교 대상 압력 기울기 (압력 교차 확인) */
  readonly crossChecks: Map<number, PressureCrossCheck[]>;
}

/**
 * 탐지 입력용 원시 P·T: 용기마다 설정·기준선 재설정을 반영한 selectHolds 결과(기준 + 최근) 구간만 읽는다.
 * 압력 교차 확인은 최근 구간에서만 쓰므로 그 구간 범위의 비교 대상(같은 뱅크 다른 용기, 없으면 압축기 토출) 압력만 더 읽는다.
 */
export async function loadTankHoldInputs(db: Kysely<DB>, index: SnapshotIndex, points: readonly PointRow[], now: number, targets: ReadonlySet<number> | null): Promise<TankHoldInputs> {
  const result = new Map<number, Map<number, TankHoldPoint[]>>();
  const recentByTank = new Map<number, TimeWindow[]>();
  for (const tank of index.assetsOfClass('h2.storage.tank').filter((t) => targets === null || targets.has(t.id))) {
    const config = resolveDetectorConfig(index.snapshot.configs, tankStaticLeak.id, { id: tank.id, classKey: tank.classKey }, tankStaticLeak);
    if (!config.ok) continue;
    const holds = index.episodesOf(tank.id, 'tank.hold').filter((e) => e.valid).map((e: TankHoldEpisode) => ({ start: e.start, end: e.end, completeness: e.dq.completeness, nPoints: e.features.n_points }));
    const { reference, recent } = selectHolds(holds, { now, referenceWindow: config.referenceWindow, baselineResetAt: index.baselineResetAt(tank.id, now) }, config.params);
    const byStart = new Map<number, TankHoldPoint[]>();
    const requests = ['tank.pressure', 'tank.temp'].map((metricKey) => ({ assetId: tank.id, metricKey }));
    for (const hold of [...new Map([...reference, ...recent].map((h) => [h.start, h])).values()]) {
      const series = await loadAssetSeries(db, requests, points, { start: hold.start - POINT_MARGIN_MS, end: hold.end + POINT_MARGIN_MS });
      byStart.set(hold.start, tankHoldPoints(series, hold));
    }
    result.set(tank.id, byStart);
    if (recent.length > 0) recentByTank.set(tank.id, recent.map((h) => ({ start: h.start, end: h.end })));
  }
  return { points: result, crossChecks: await loadCrossChecks(db, index, points, recentByTank) };
}

/** 최근 구간 전체를 덮는 창 (비교 대상 압력을 한 번에 읽는다) */
function spanOf(windows: readonly TimeWindow[]): TimeWindow {
  return { start: Math.min(...windows.map((w) => w.start)) - POINT_MARGIN_MS, end: Math.max(...windows.map((w) => w.end)) + POINT_MARGIN_MS };
}

async function pressureSeriesOf(db: Kysely<DB>, assetId: number, metricKey: string, points: readonly PointRow[], span: TimeWindow): Promise<TimedValue[]> {
  const series = await loadAssetSeries(db, [{ assetId, metricKey }], points, span);
  return goodPoints(series, metricKey);
}

/**
 * 용기마다 최근 구간의 비교 대상 압력 기울기. 비교 대상은 같은 뱅크(상위 설비)의 다른 용기이고,
 * 다른 용기가 없으면 같은 사이트 압축기 토출 압력을 쓴다. 비교 대상이 없으면 그 용기는 결과에 넣지 않는다.
 */
async function loadCrossChecks(db: Kysely<DB>, index: SnapshotIndex, points: readonly PointRow[], recentByTank: ReadonlyMap<number, readonly TimeWindow[]>): Promise<Map<number, PressureCrossCheck[]>> {
  const result = new Map<number, PressureCrossCheck[]>();
  if (recentByTank.size === 0) return result;
  const tanks = index.assetsOfClass('h2.storage.tank');
  const bankOf = new Map(tanks.map((t) => [t.id, t.parentId]));
  const peerIds = new Map([...recentByTank.keys()].map((id) => [id, tanks.filter((t) => t.id !== id && t.parentId === bankOf.get(id)).map((t) => t.id)]));
  const span = spanOf([...recentByTank.values()].flat());
  const byAsset = new Map<number, TimedValue[]>();
  for (const id of new Set([...peerIds.values()].flat())) byAsset.set(id, await pressureSeriesOf(db, id, 'tank.pressure', points, span));
  const compressor = [...peerIds.values()].some((ids) => ids.length === 0) ? index.assetsOfClass('h2.compressor')[0] : undefined;
  const discharge = compressor ? await pressureSeriesOf(db, compressor.id, 'compressor.discharge.pressure', points, span) : [];
  for (const [tankId, windows] of recentByTank) {
    const peers = (peerIds.get(tankId) ?? []).map((id) => byAsset.get(id) ?? []).filter((series) => series.length > 0);
    const checks = peers.length > 0 ? pressureCrossChecks(peers, 'peer_tank', windows) : discharge.length > 0 ? pressureCrossChecks([discharge], 'compressor_discharge', windows) : [];
    if (checks.length > 0) result.set(tankId, checks);
  }
  return result;
}
