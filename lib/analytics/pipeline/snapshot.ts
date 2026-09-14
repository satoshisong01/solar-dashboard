// 사이트 스냅샷: 탐지기 입력을 만들 설비·에피소드·이벤트·설정 묶음과 조회 색인 (순수).
import type { DqGapFlatlineInput } from '../detectors/dq-gap-flatline';
import type { EssCapacityInput } from '../detectors/ess-capacity-fade';
import type { AssetEventInput } from '../detectors/types';
import type { EpisodeKind } from '../episodes/types';
import type { AssetEventRow, DetectorConfigRow, PipelineAsset, StoredEpisode } from './types';

export interface SiteSnapshot {
  readonly siteId: number;
  readonly assets: readonly PipelineAsset[];
  /** 기준선부터 분석 시각까지의 에피소드 (종류·설비 섞여 있어도 된다) */
  readonly episodes: readonly StoredEpisode[];
  readonly events: readonly AssetEventRow[];
  readonly configs: readonly DetectorConfigRow[];
  /** dq.gap_flatline 입력. 없으면 그 탐지기를 실행하지 않는다 */
  readonly dq?: DqGapFlatlineInput | null;
  /** 설비 id → 충전 곡선 (ess.capacity_fade 에피소드 오버레이) */
  readonly curves?: ReadonlyMap<number, NonNullable<EssCapacityInput['curves']>>;
}

type EpisodeOfKind<K extends EpisodeKind> = Extract<StoredEpisode, { kind: K }>;

export interface SnapshotIndex {
  readonly snapshot: SiteSnapshot;
  readonly assetById: ReadonlyMap<number, PipelineAsset>;
  episodesOf<K extends EpisodeKind>(assetId: number, kind: K): readonly EpisodeOfKind<K>[];
  /** 설비와 상위 설비들의 이벤트 (시각 오름차순) */
  eventsFor(assetId: number): readonly AssetEventInput[];
  /** now 이전 마지막 기준선 재설정 시각 (설비·상위 설비) */
  baselineResetAt(assetId: number, now: number): number | undefined;
  assetsOfClass(classKey: string): readonly PipelineAsset[];
}

function ancestorIds(assetId: number, assetById: ReadonlyMap<number, PipelineAsset>): number[] {
  const ids: number[] = [];
  let current = assetById.get(assetId);
  while (current && !ids.includes(current.id)) {
    ids.push(current.id);
    current = current.parentId === null ? undefined : assetById.get(current.parentId);
  }
  return ids;
}

function groupEpisodes(episodes: readonly StoredEpisode[]): Map<string, StoredEpisode[]> {
  const groups = new Map<string, StoredEpisode[]>();
  for (const episode of episodes) {
    const key = `${episode.assetId}|${episode.kind}`;
    const list = groups.get(key);
    if (list) list.push(episode); // 이 함수 안에서 만든 배열만 채운다
    else groups.set(key, [episode]);
  }
  for (const list of groups.values()) list.sort((a, b) => a.start - b.start);
  return groups;
}

export function indexSnapshot(snapshot: SiteSnapshot): SnapshotIndex {
  const assetById = new Map(snapshot.assets.map((a) => [a.id, a]));
  const groups = groupEpisodes(snapshot.episodes);
  const eventsFor = (assetId: number): AssetEventInput[] => {
    const ids = new Set(ancestorIds(assetId, assetById));
    return snapshot.events.filter((e) => ids.has(e.assetId)).sort((a, b) => a.ts - b.ts).map(({ ts, kind, resetsBaseline, note }) => ({ ts, kind, resetsBaseline, note: note ?? null }));
  };
  return {
    snapshot,
    assetById,
    episodesOf: <K extends EpisodeKind>(assetId: number, kind: K) => (groups.get(`${assetId}|${kind}`) ?? []).filter((e): e is EpisodeOfKind<K> => e.kind === kind),
    eventsFor,
    baselineResetAt: (assetId, now) => {
      const resets = eventsFor(assetId).filter((e) => e.resetsBaseline && e.ts <= now);
      return resets.at(-1)?.ts;
    },
    assetsOfClass: (classKey) => snapshot.assets.filter((a) => a.classKey === classKey).sort((a, b) => a.id - b.id),
  };
}
