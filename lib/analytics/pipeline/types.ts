// 분석 파이프라인 공용 타입 (순수). DB 실행기(lib/analysis)와 시뮬레이터 평가(lib/sim/eval)가 같은 조립 규칙을 쓴다.
import type { AssetEventInput, CandidateFinding } from '../detectors/types';
import type { CompRunEpisode } from '../episodes/compressor';
import type { EssChargeEpisode, EssDischargeEpisode, EssRestEpisode } from '../episodes/ess';
import type { EssStepEpisode } from '../episodes/ess-steps';
import type { FcBlowerRunEpisode } from '../episodes/fc-blower';
import type { PvDayEpisode } from '../episodes/pv';
import type { ElStartEpisode, ElSteadyEpisode, FcStartEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import type { TankHoldEpisode } from '../episodes/tank-hold';
import type { WxDayEpisode } from '../episodes/wx-day';
import type { TimeWindow } from '../types';

/** 분석 대상 설비 (om.asset 한 행) */
export interface PipelineAsset {
  readonly id: number;
  readonly siteId: number;
  readonly parentId: number | null;
  /** 사이트 안 경로 (예: ESS1/RACK01) */
  readonly code: string;
  readonly classKey: string;
  readonly peerGroup: string | null;
  readonly nameplate: Readonly<Record<string, unknown>>;
  /** 준공일 KST 0시 (epoch ms) */
  readonly commissionedAt: number | null;
}

/** om.episode에 저장하는 에피소드 전부 */
export type StoredEpisode =
  | EssChargeEpisode
  | EssDischargeEpisode
  | EssRestEpisode
  | PvDayEpisode
  | ElSteadyEpisode
  | ElStartEpisode
  | FcSteadyEpisode
  | FcStartEpisode
  | EssStepEpisode
  | CompRunEpisode
  | TankHoldEpisode
  | FcBlowerRunEpisode
  | WxDayEpisode;

/** om.asset_event 한 행 */
export interface AssetEventRow extends AssetEventInput {
  readonly assetId: number;
}

/** om.detector_config 활성 행 */
export interface DetectorConfigRow {
  readonly detectorId: string;
  /** 'default' | 'class:<class_key>' | 'asset:<asset.id>' */
  readonly scope: string;
  readonly version: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly referenceWindow: TimeWindow | null;
}

export type DetectorOutcomeStatus = 'ok' | 'insufficient' | 'error';

/** 탐지기 실행에 적용한 설정 (근거 스냅샷 config) */
export interface ConfigRef {
  /** 가장 좁은 적용 범위 ('default' · 'class:…' · 'asset:…'), 설정 행이 없으면 'code_default' */
  readonly scope: string;
  readonly version: number | null;
  /** 적용 파라미터(코드 기본값 + 설정) 해시 앞 16자 */
  readonly paramsHash: string;
  /** 적용한 설정 'scope@version' (넓은 범위부터) */
  readonly applied: readonly string[];
}

/** 탐지기 한 번 실행 결과 (설비 단위 탐지기는 설비마다, 사이트 단위 탐지기는 사이트·동종 그룹마다) */
export interface DetectorOutcome {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly siteId: number;
  /** 설비 단위 실행이면 설비 id, 사이트·동종 그룹 단위면 null */
  readonly assetId: number | null;
  readonly status: DetectorOutcomeStatus;
  readonly findings: readonly CandidateFinding[];
  /** insufficient·error 이유 */
  readonly reason: string | null;
  /** 적용한 설정 버전 (scope@version 목록, 설정이 없으면 빈 배열) */
  readonly configVersions: readonly string[];
  readonly config: ConfigRef;
}
