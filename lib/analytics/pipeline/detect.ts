// 사이트 스냅샷 → 탐지기 14종 실행 (순수). 설비별 입력 조립·설정 병합·검증·기준선 재설정·동종 비교를 한곳에서 정한다.
// DB 실행기(lib/analysis)와 시뮬레이터 평가(lib/sim/eval)가 같은 함수를 쓴다. P3 탐지기 입력 조립은 detect-p3.ts.
// 탐지기는 PIPELINE_DETECTOR_IDS 순서로 실행하고, 뒤 탐지기는 앞 결과를 판별 체크에 쓴다
// (ess.resistance_growth ← ess.capacity_fade, h2chain.mass_balance_gap ← tank.static_leak).
import { dqGapFlatline } from '../detectors/dq-gap-flatline';
import { essCapacityFade } from '../detectors/ess-capacity-fade';
import { cellDvPoints, essCellImbalance } from '../detectors/ess-cell-imbalance';
import { pvInverterPeer } from '../detectors/pv-inverter-peer';
import { elVoltageRise, fcVoltageDecay } from '../detectors/stack-detectors';
import { median } from '../stats/robust';
import { MS_PER_DAY } from '../types';
import { resolveDetectorConfig } from './config';
import { assetTarget, isTarget, latestReset, PIPELINE_DETECTOR_IDS, runOne, targetsOfClass, type DetectOptions, type P3PipelineDetectorId, type PipelineDetectorId, type Runner } from './detect-common';
import { P3_RUNNERS } from './detect-p3';
import { indexSnapshot, type SiteSnapshot, type SnapshotIndex } from './snapshot';
import type { DetectorOutcome, PipelineAsset } from './types';

export { P2_PIPELINE_DETECTOR_IDS, P3_PIPELINE_DETECTOR_IDS, PIPELINE_DETECTOR_IDS, type DetectOptions, type PipelineDetectorId } from './detect-common';

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
  const config = resolveDetectorConfig(index.snapshot.configs, essCellImbalance.id, assetTarget(rack), essCellImbalance);
  const p = config.ok ? config.params : essCellImbalance.defaultParams;
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
    return [
      runOne(index, options, {
        detector: pvInverterPeer,
        configTarget: { id: null, classKey: 'pv.inverter' },
        assetId: null,
        baselineResetAt: latestReset(index, members, options.now),
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

const RUNNERS: Readonly<Record<PipelineDetectorId, Runner>> = {
  'dq.gap_flatline': dqRuns,
  'ess.capacity_fade': capacityRuns,
  'ess.cell_imbalance': cellImbalanceRuns,
  'pv.inverter_peer': inverterPeerRuns,
  'el.voltage_rise': (index, options) => stackRuns(index, options, 'el'),
  'fc.voltage_decay': (index, options) => stackRuns(index, options, 'fc'),
  ...(P3_RUNNERS satisfies Readonly<Record<P3PipelineDetectorId, Runner>>),
};

/** 스냅샷에서 탐지기를 실행한다. 탐지기 예외는 status 'error' 결과로 바꿔 다른 탐지기를 막지 않는다 */
export function runSiteDetectors(snapshot: SiteSnapshot | SnapshotIndex, options: DetectOptions): DetectorOutcome[] {
  const index = 'episodesOf' in snapshot ? snapshot : indexSnapshot(snapshot);
  const selected = options.detectorIds ?? PIPELINE_DETECTOR_IDS;
  const ordered = PIPELINE_DETECTOR_IDS.filter((id) => selected.includes(id));
  return ordered.reduce<DetectorOutcome[]>((outcomes, id) => [...outcomes, ...RUNNERS[id](index, options, [...(options.priorOutcomes ?? []), ...outcomes])], []);
}
