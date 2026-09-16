// 가평 구성 탐지기 3종 입력 조립 (순수). 표본은 에피소드가 아니라 1시간 롤업에서 만든 것이라 snapshot.aux로 들어온다.
//   prv.seat_leak   감압밸브(h2.prv) 설비마다 무유동 hold 구간
//   hx.fouling      폐열회수 열교환기(hx.recovery) 설비마다 정상상태 표본
//   o2.purity_drift 산소 계통(o2.plant) 설비마다 전해조 운전일 HTO
import { hxFouling } from '../detectors/hx-fouling';
import { o2PurityDrift } from '../detectors/o2-purity-drift';
import { prvSeatLeak } from '../detectors/prv-seat-leak';
import { assetTarget, runOne, targetsOfClass, type DetectOptions, type GapyeongPipelineDetectorId, type Runner } from './detect-common';
import type { SnapshotIndex } from './snapshot';
import type { PipelineAsset } from './types';

const num = (asset: PipelineAsset, key: string): number | null => {
  const value = Number(asset.nameplate[key]);
  return asset.nameplate[key] !== undefined && asset.nameplate[key] !== null && Number.isFinite(value) ? value : null;
};

const common = (index: SnapshotIndex, options: DetectOptions, asset: PipelineAsset) => ({ configTarget: assetTarget(asset), assetId: asset.id, baselineResetAt: index.baselineResetAt(asset.id, options.now) });

const prvRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'h2.prv').map((prv) =>
    runOne(index, options, {
      ...common(index, options, prv),
      detector: prvSeatLeak,
      input: {
        assetId: prv.id,
        outletSetBar: num(prv, 'outlet_bar_set'),
        downstreamVolumeM3: num(prv, 'downstream_volume_m3'),
        holds: index.snapshot.aux?.prvHolds?.get(prv.id) ?? [],
      },
    }),
  );

const hxRuns: Runner = (index, options) =>
  targetsOfClass(index, options, 'hx.recovery').map((hx) =>
    runOne(index, options, {
      ...common(index, options, hx),
      detector: hxFouling,
      input: {
        assetId: hx.id,
        designApproachK: num(hx, 'design_approach_k'),
        designUaKwK: num(hx, 'design_ua_kw_k'),
        samples: index.snapshot.aux?.hxSamples?.get(hx.id) ?? [],
      },
    }),
  );

const o2Runs: Runner = (index, options) =>
  targetsOfClass(index, options, 'o2.plant').map((plant) =>
    runOne(index, options, {
      ...common(index, options, plant),
      detector: o2PurityDrift,
      input: {
        assetId: plant.id,
        days: index.snapshot.aux?.htoDays?.get(plant.id) ?? [],
        calibrationTs: index.eventsFor(plant.id).filter((e) => e.kind === 'calibration').map((e) => e.ts),
      },
    }),
  );

export const GAPYEONG_RUNNERS: Readonly<Record<GapyeongPipelineDetectorId, Runner>> = {
  'prv.seat_leak': prvRuns,
  'hx.fouling': hxRuns,
  'o2.purity_drift': o2Runs,
};
