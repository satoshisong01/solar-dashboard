// 사이트 스냅샷 → P2 탐지기 6종 실행 (순수). 설비별 입력 조립·설정 병합·기준선 재설정·동종 비교를 한곳에서 정한다.
// DB 실행기(lib/analysis)와 시뮬레이터 평가(lib/sim/eval)가 같은 함수를 쓴다.
import { deriveRng } from '@/lib/sim/rng';
import { dqGapFlatline } from '../detectors/dq-gap-flatline';
import { essCapacityFade } from '../detectors/ess-capacity-fade';
import { cellDvPoints, essCellImbalance } from '../detectors/ess-cell-imbalance';
import { pvInverterPeer } from '../detectors/pv-inverter-peer';
import { elVoltageRise, fcVoltageDecay } from '../detectors/stack-detectors';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult } from '../detectors/types';
import { median } from '../stats/robust';
import { MS_PER_DAY } from '../types';
import { resolveDetectorConfig, type ConfigTarget } from './config';
import { indexSnapshot, type SiteSnapshot, type SnapshotIndex } from './snapshot';
import type { DetectorOutcome, PipelineAsset } from './types';

export const PIPELINE_DETECTOR_IDS = ['dq.gap_flatline', 'ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay'] as const;
export type PipelineDetectorId = (typeof PIPELINE_DETECTOR_IDS)[number];

export interface DetectOptions {
  /** 분석 시각 (보통 분석 기간 끝) */
  readonly now: number;
  /** 부트스트랩 난수 시드. 탐지기·설비마다 독립 스트림을 만든다 (같은 시드 → 같은 결과) */
  readonly seed: number;
  /** 결과를 남길 설비. 생략하면 전부 (동종 비교에는 대상이 아닌 설비 에피소드도 쓴다) */
  readonly targetAssetIds?: ReadonlySet<number>;
  /** 실행할 탐지기. 생략하면 6종 전부 */
  readonly detectorIds?: readonly PipelineDetectorId[];
}

interface RunSpec<I, P> {
  readonly detector: Detector<I, P>;
  readonly input: I;
  readonly configTarget: ConfigTarget | null;
  readonly assetId: number | null;
  readonly baselineResetAt?: number;
  /** 결과 finding 필터 (동종 그룹 실행에서 대상 설비만 남긴다) */
  readonly keep?: (finding: CandidateFinding) => boolean;
}

function runOne<I, P extends object>(index: SnapshotIndex, options: DetectOptions, spec: RunSpec<I, P>): DetectorOutcome {
  const { detector } = spec;
  const config = resolveDetectorConfig(index.snapshot.configs, detector.id, spec.configTarget, detector.defaultParams);
  const base = { detectorId: detector.id, detectorVersion: detector.version, siteId: index.snapshot.siteId, assetId: spec.assetId, configVersions: config.versions };
  const ctx: DetectorContext<P> = {
    now: options.now,
    rng: deriveRng(options.seed, detector.id, index.snapshot.siteId, spec.assetId ?? spec.configTarget?.classKey ?? 'site'),
    params: config.params,
    referenceWindow: config.referenceWindow,
    baselineResetAt: spec.baselineResetAt,
  };
  let result: DetectorResult;
  try {
    result = detector.detect(spec.input, ctx);
  } catch (error) {
    return { ...base, status: 'error', findings: [], reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.status === 'insufficient') return { ...base, status: 'insufficient', findings: [], reason: result.reason };
  return { ...base, status: 'ok', findings: spec.keep ? result.findings.filter(spec.keep) : result.findings, reason: null };
}

const isTarget = (options: DetectOptions, assetId: number): boolean => options.targetAssetIds?.has(assetId) ?? true;
const targetsOfClass = (index: SnapshotIndex, options: DetectOptions, classKey: string): readonly PipelineAsset[] => index.assetsOfClass(classKey).filter((a) => isTarget(options, a.id));
const assetTarget = (asset: PipelineAsset): ConfigTarget => ({ id: asset.id, classKey: asset.classKey });

function ratedCapacityAh(asset: PipelineAsset): number {
  const value = Number(asset.nameplate.capacity_ah);
  return Number.isFinite(value) ? value : 0;
}

function capacityRuns(index: SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  return targetsOfClass(index, options, 'ess.rack').map((rack) =>
    runOne(index, options, {
      detector: essCapacityFade,
      configTarget: assetTarget(rack),
      assetId: rack.id,
      baselineResetAt: index.baselineResetAt(rack.id, options.now),
      input: {
        assetId: rack.id,
        ratedCapacityAh: ratedCapacityAh(rack),
        commissionedAt: rack.commissionedAt,
        sessions: index.episodesOf(rack.id, 'ess.charge'),
        discharges: index.episodesOf(rack.id, 'ess.discharge'),
        rests: index.episodesOf(rack.id, 'ess.rest'),
        events: index.eventsFor(rack.id),
        curves: index.snapshot.curves?.get(rack.id),
      },
    }),
  );
}

/** 동종 랙의 최근 충전 종료 셀 전압 편차 중앙값 (없으면 뺀다) */
function peerDvMedians(index: SnapshotIndex, rack: PipelineAsset, now: number): { assetId: number; recentDvMv: number }[] {
  const config = resolveDetectorConfig(index.snapshot.configs, essCellImbalance.id, assetTarget(rack), essCellImbalance.defaultParams);
  const p = { ...essCellImbalance.defaultParams, ...config.params };
  const peers = rack.peerGroup === null ? [] : index.assetsOfClass('ess.rack').filter((a) => a.id !== rack.id && a.peerGroup === rack.peerGroup);
  return peers.flatMap((peer) => {
    const values = cellDvPoints(index.episodesOf(peer.id, 'ess.charge'), index.episodesOf(peer.id, 'ess.rest'))
      .filter((pt) => pt.source === p.source && pt.ts <= now && pt.ts >= now - p.recentDays * MS_PER_DAY && pt.completeness >= p.minCompleteness)
      .map((pt) => pt.dvMv);
    return values.length > 0 ? [{ assetId: peer.id, recentDvMv: median(values) }] : [];
  });
}

function cellImbalanceRuns(index: SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  return targetsOfClass(index, options, 'ess.rack').map((rack) =>
    runOne(index, options, {
      detector: essCellImbalance,
      configTarget: assetTarget(rack),
      assetId: rack.id,
      baselineResetAt: index.baselineResetAt(rack.id, options.now),
      input: {
        assetId: rack.id,
        points: cellDvPoints(index.episodesOf(rack.id, 'ess.charge'), index.episodesOf(rack.id, 'ess.rest')),
        peers: peerDvMedians(index, rack, options.now),
      },
    }),
  );
}

/** 사이트 인버터를 동종 그룹별로 한 번씩 비교한다. 기준선 재설정은 그룹 안 가장 늦은 재설정을 쓴다 */
function inverterPeerRuns(index: SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  const inverters = index.assetsOfClass('pv.inverter');
  const groups = [...new Set(inverters.map((inv) => inv.peerGroup ?? `solo:${inv.id}`))].sort();
  return groups.flatMap((group) => {
    const members = inverters.filter((inv) => (inv.peerGroup ?? `solo:${inv.id}`) === group);
    if (!members.some((inv) => isTarget(options, inv.id))) return [];
    const resets = members.map((inv) => index.baselineResetAt(inv.id, options.now)).filter((ts): ts is number => ts !== undefined);
    return [
      runOne(index, options, {
        detector: pvInverterPeer,
        configTarget: { id: null, classKey: 'pv.inverter' },
        assetId: null,
        baselineResetAt: resets.length > 0 ? Math.max(...resets) : undefined,
        input: { siteId: index.snapshot.siteId, days: members.flatMap((inv) => index.episodesOf(inv.id, 'pv.day')) },
        keep: (finding) => finding.assetId !== null && isTarget(options, finding.assetId),
      }),
    ];
  });
}

function stackRuns(index: SnapshotIndex, options: DetectOptions, which: 'el' | 'fc'): DetectorOutcome[] {
  const classKey = which === 'el' ? 'h2.elz.stack' : 'fc.stack';
  return targetsOfClass(index, options, classKey).map((stack) => {
    const common = { configTarget: assetTarget(stack), assetId: stack.id, baselineResetAt: index.baselineResetAt(stack.id, options.now) };
    return which === 'el'
      ? runOne(index, options, { ...common, detector: elVoltageRise, input: { assetId: stack.id, episodes: index.episodesOf(stack.id, 'el.steady_run') } })
      : runOne(index, options, { ...common, detector: fcVoltageDecay, input: { assetId: stack.id, episodes: index.episodesOf(stack.id, 'fc.steady_run') } });
  });
}

function dqRuns(index: SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  const dq = index.snapshot.dq;
  if (!dq) return [];
  const points = dq.points.filter((pt) => isTarget(options, pt.assetId));
  return [runOne(index, options, { detector: dqGapFlatline, configTarget: null, assetId: null, input: { ...dq, points } })];
}

const RUNNERS: Readonly<Record<PipelineDetectorId, (index: SnapshotIndex, options: DetectOptions) => DetectorOutcome[]>> = {
  'dq.gap_flatline': dqRuns,
  'ess.capacity_fade': capacityRuns,
  'ess.cell_imbalance': cellImbalanceRuns,
  'pv.inverter_peer': inverterPeerRuns,
  'el.voltage_rise': (index, options) => stackRuns(index, options, 'el'),
  'fc.voltage_decay': (index, options) => stackRuns(index, options, 'fc'),
};

/** 스냅샷에서 탐지기를 실행한다. 탐지기 예외는 status 'error' 결과로 바꿔 다른 탐지기를 막지 않는다 */
export function runSiteDetectors(snapshot: SiteSnapshot | SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  const index = 'episodesOf' in snapshot ? snapshot : indexSnapshot(snapshot);
  return (options.detectorIds ?? PIPELINE_DETECTOR_IDS).flatMap((id) => RUNNERS[id](index, options));
}
