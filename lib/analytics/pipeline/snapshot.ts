// 사이트 스냅샷: 탐지기 입력을 만들 설비·에피소드·이벤트·설정 묶음과 조회 색인 (순수).
import type { TimedNumber } from '../detectors/common';
import type { DqGapFlatlineInput } from '../detectors/dq-gap-flatline';
import type { EssCapacityInput } from '../detectors/ess-capacity-fade';
import type { InverterFaultEvent } from '../detectors/inv-thermal-derating';
import type { PressureCrossCheck } from '../detectors/tank-peer-pressure';
import type { AssetEventInput } from '../detectors/types';
import type { HtoDay, HxSample, PrvHold } from '../episodes/gapyeong-samples';
import type { InverterThermalSample } from '../episodes/inverter-thermal';
import type { TankHoldPoint } from '../episodes/tank-hold';
import type { EpisodeKind } from '../episodes/types';
import type { LedgerDayRow } from './site-ledger';
import type { AssetEventRow, DetectorConfigRow, PipelineAsset, StoredEpisode } from './types';

/**
 * P3 탐지기 입력 중 에피소드가 아닌 것 (load 계층·평가가 채운다). 없으면 해당 탐지기는 판정 불능이거나 판별 체크가 데이터없음이다.
 */
export interface SiteAuxInputs {
  /** 저장용기 id → 정지 보유 구간 시작 시각 → 압력·온도 짝 (tank.static_leak). 점이 없는 구간은 입력에서 뺀다 */
  readonly tankHoldPoints?: ReadonlyMap<number, ReadonlyMap<number, readonly TankHoldPoint[]>>;
  /** 저장용기 id → 최근 정지 구간별 비교 대상 압력 기울기 (tank.static_leak 압력 교차 확인). 없으면 그 체크는 데이터없음 */
  readonly tankCrossChecks?: ReadonlyMap<number, readonly PressureCrossCheck[]>;
  /** 인버터 열 저감 버킷 표본 (inv.thermal_derating, thermalSampleWindow 기간) */
  readonly thermalSamples?: readonly InverterThermalSample[];
  /** 인버터 고장·경보 코드 (event_log). 없으면 냉각팬 체크는 데이터없음 */
  readonly inverterFaultEvents?: readonly InverterFaultEvent[];
  /** 전해조 스택 id → 정류기 효율 일 중앙값 [%] (el.sec_rise) */
  readonly rectifierEfficiency?: ReadonlyMap<number, readonly TimedNumber[]>;
  /** 전해조 스택 id → 일 퍼지 횟수 증가분 [회] (el.sec_rise 퍼지 체크). 전해조에 퍼지 카운터 포인트가 없으면 비어 있다 */
  readonly purgeCounts?: ReadonlyMap<number, readonly TimedNumber[]>;
  /** 사이트 체인 원장 일 행 (h2chain.mass_balance_gap) */
  readonly ledgerDays?: readonly LedgerDayRow[];
  /** 태양광 세척 시각 (maintenance_action 등 asset_event 밖의 기록. asset_event 세척은 탐지기 실행기가 따로 고른다) */
  readonly cleaningTs?: readonly number[];
  /** 최근 SMP [원/kWh] (market_daily) */
  readonly smpKrwPerKwh?: number | null;
  /** 감압밸브 id → 무유동 hold 구간 (prv.seat_leak) */
  readonly prvHolds?: ReadonlyMap<number, readonly PrvHold[]>;
  /** 폐열회수 열교환기 id → 정상상태 시간 표본 (hx.fouling) */
  readonly hxSamples?: ReadonlyMap<number, readonly HxSample[]>;
  /** 산소 계통 id → 전해조 운전일 HTO (o2.purity_drift) */
  readonly htoDays?: ReadonlyMap<number, readonly HtoDay[]>;
}

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
  readonly aux?: SiteAuxInputs;
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
