// 탐지기 실행 공용 도우미 (순수): 실행 옵션, 설정 병합·검증 후 탐지기 한 번 실행, 대상 설비 선택.
import { deriveRng } from '@/lib/sim/rng';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult } from '../detectors/types';
import { resolveDetectorConfig, type ConfigTarget } from './config';
import type { SnapshotIndex } from './snapshot';
import type { DetectorOutcome, PipelineAsset } from './types';

/** 파이프라인 탐지기 id (실행 순서) */
export const P2_PIPELINE_DETECTOR_IDS = ['dq.gap_flatline', 'ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay'] as const;
export const P3_PIPELINE_DETECTOR_IDS = ['el.sec_rise', 'tank.static_leak', 'comp.sec_rise', 'fc.blower_wear', 'pv.soiling_rate', 'ess.resistance_growth', 'inv.thermal_derating', 'h2chain.mass_balance_gap'] as const;
export const PIPELINE_DETECTOR_IDS = [...P2_PIPELINE_DETECTOR_IDS, ...P3_PIPELINE_DETECTOR_IDS] as const;
export type PipelineDetectorId = (typeof PIPELINE_DETECTOR_IDS)[number];
export type P3PipelineDetectorId = (typeof P3_PIPELINE_DETECTOR_IDS)[number];

export interface DetectOptions {
  /** 분석 시각 (보통 분석 기간 끝) */
  readonly now: number;
  /** 부트스트랩 난수 시드. 탐지기·설비마다 독립 스트림을 만든다 (같은 시드 → 같은 결과) */
  readonly seed: number;
  /** 결과를 남길 설비. 생략하면 전부 (동종 비교에는 대상이 아닌 설비 에피소드도 쓴다) */
  readonly targetAssetIds?: ReadonlySet<number>;
  /** 실행할 탐지기 (실행 순서는 항상 PIPELINE_DETECTOR_IDS 순). 생략하면 14종 전부 */
  readonly detectorIds?: readonly PipelineDetectorId[];
  /** 앞 단계에서 이미 실행한 결과 (판별 체크 교차 입력으로만 쓰고 반환에는 넣지 않는다) */
  readonly priorOutcomes?: readonly DetectorOutcome[];
}

export interface RunSpec<I, P> {
  readonly detector: Detector<I, P>;
  readonly input: I;
  readonly configTarget: ConfigTarget | null;
  readonly assetId: number | null;
  readonly baselineResetAt?: number;
  /** 결과 finding 필터 (동종 그룹 실행에서 대상 설비만 남긴다) */
  readonly keep?: (finding: CandidateFinding) => boolean;
}

export function runOne<I, P extends object>(index: SnapshotIndex, options: DetectOptions, spec: RunSpec<I, P>): DetectorOutcome {
  const { detector } = spec;
  const config = resolveDetectorConfig(index.snapshot.configs, detector.id, spec.configTarget, detector);
  const base = { detectorId: detector.id, detectorVersion: detector.version, siteId: index.snapshot.siteId, assetId: spec.assetId, configVersions: config.versions, config: config.ref };
  if (!config.ok) return { ...base, status: 'insufficient', findings: [], reason: config.reason };
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

export const isTarget = (options: DetectOptions, assetId: number): boolean => options.targetAssetIds?.has(assetId) ?? true;
export const targetsOfClass = (index: SnapshotIndex, options: DetectOptions, classKey: string): readonly PipelineAsset[] => index.assetsOfClass(classKey).filter((a) => isTarget(options, a.id));
export const assetTarget = (asset: PipelineAsset): ConfigTarget => ({ id: asset.id, classKey: asset.classKey });

/** 그룹 안 가장 늦은 기준선 재설정 */
export function latestReset(index: SnapshotIndex, members: readonly PipelineAsset[], now: number): number | undefined {
  const resets = members.map((a) => index.baselineResetAt(a.id, now)).filter((ts): ts is number => ts !== undefined);
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

export type Runner = (index: SnapshotIndex, options: DetectOptions, prior: readonly DetectorOutcome[]) => DetectorOutcome[];
