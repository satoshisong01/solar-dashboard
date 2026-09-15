// 저장용기 정지 보유 구간 (tank.static_leak): 원시를 전부 읽지 않는다.
//   추출: 1시간 롤업에서 유입·유출이 멈춘 시간 후보(tankHoldWindows) → 그 창만 원시(용기 P·T + 흐름 신호)를 읽어 tank.hold 에피소드 추출·저장
//   탐지: 저장된 에피소드에서 탐지기와 같은 규칙(selectHolds)으로 기준·최근 구간만 골라 그 구간의 원시 P·T만 읽는다
import type { Kysely } from 'kysely';
import { selectHolds, tankStaticLeak } from '@/lib/analytics/detectors/tank-static-leak';
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

/**
 * 탐지 입력용 원시 P·T: 용기마다 설정·기준선 재설정을 반영한 selectHolds 결과(기준 + 최근) 구간만 읽는다.
 * 반환: 용기 id → 구간 시작 → 압력·온도 짝
 */
export async function loadTankHoldPoints(db: Kysely<DB>, index: SnapshotIndex, points: readonly PointRow[], now: number, targets: ReadonlySet<number> | null): Promise<Map<number, Map<number, TankHoldPoint[]>>> {
  const result = new Map<number, Map<number, TankHoldPoint[]>>();
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
  }
  return result;
}
