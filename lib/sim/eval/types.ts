// 시뮬레이터 평가 결과 타입 (잡 → 워커 → 집계). 모두 JSON으로 주고받을 수 있는 값이다.
import type { ControlEventTruth, InjectionTruth } from '../truth';

/** 메모리 모드에서 평가하는 탐지기. dq.gap_flatline은 저장값 수준 결측·고착 주입만 평가한다 (전송 계층 단절·지연은 DB E2E 모드) */
export const EVAL_DETECTOR_IDS = ['ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay', 'dq.gap_flatline'] as const;
export type EvalDetectorId = (typeof EVAL_DETECTOR_IDS)[number];

/** 탐지기가 적용되는 설비 종류 ('*' = 데이터 품질 포인트가 있는 모든 설비) */
export const EVAL_DETECTOR_CLASS: Readonly<Record<EvalDetectorId, string>> = {
  'dq.gap_flatline': '*',
  'ess.capacity_fade': 'ess.rack',
  'ess.cell_imbalance': 'ess.rack',
  'pv.inverter_peer': 'pv.inverter',
  'el.voltage_rise': 'h2.elz.stack',
  'fc.voltage_decay': 'fc.stack',
};

/** bin별 기준을 쓴 비교에서 결합에 쓴 bin 하나의 기준·최근 기간과 결합 가중치 */
export interface BinWindow {
  readonly referenceFrom: number;
  readonly referenceTo: number;
  readonly recentFrom: number;
  readonly recentTo: number;
  readonly weight: number;
}

export interface EvidenceWindows {
  readonly referenceFrom: number;
  readonly referenceTo: number;
  readonly recentFrom: number;
  readonly recentTo: number;
  /** 결합에 쓴 bin별 기간 (근거에 없으면 빈 배열 → 전체 기간으로 참값을 계산) */
  readonly bins: readonly BinWindow[];
}

/** 점검 시각 하나에서 나온 finding 요약 */
export interface DetectionRecord {
  readonly ts: number;
  readonly detectorId: string;
  readonly assetId: number;
  readonly failureMode: string;
  readonly severity: number;
  readonly confidence: number;
  readonly effect: number;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly windows: EvidenceWindows | null;
}

export interface OutcomeTally {
  readonly detectorId: string;
  readonly ok: number;
  readonly insufficient: number;
  readonly error: number;
  /** 이유 앞부분 → 횟수 (많은 순 5개) */
  readonly topReasons: readonly (readonly [reason: string, count: number])[];
}

export interface InjectionResult {
  readonly injection: InjectionTruth;
  readonly detectorId: string;
  readonly assetId: number;
  /** 스윕 크기 (용량 %, 인버터 %p, 스택 µV/h) */
  readonly magnitude: number;
  readonly unit: string;
  readonly firstDetectionTs: number | null;
  /** 마지막으로 탐지한 점검 시각의 효과 크기 */
  readonly finalEffect: number | null;
  /** 같은 창의 참 크기 (용량: 참 SOH 비율 변화 %, 인버터: −%p, 스택: 주입 µV/h). 계산할 수 없으면 null */
  readonly trueEffect: number | null;
}

/** 주입 고장이 함께 일으킬 수 있는 다른 탐지기의 finding 구간 (주입 설비와 하위 설비, 오탐으로 세지 않는다) */
export interface RelatedWindow {
  readonly detectorId: string;
  readonly assetIds: readonly number[];
  readonly startTs: number;
  readonly endTs: number | null;
}

/** 점검 시각 하나에서 설비 단위 탐지기 한 대의 판정 상태 (ess.capacity_fade 판정 가능 기간 집계용) */
export interface CheckpointStatus {
  readonly ts: number;
  readonly assetId: number;
  readonly status: 'ok' | 'insufficient' | 'error';
}

export interface SiteJobStats {
  readonly simulationMs: number;
  readonly extractionMs: number;
  readonly detectionMs: number;
  readonly samples: number;
  readonly episodes: number;
}

export interface SiteJobResult {
  readonly jobId: string;
  readonly seed: number;
  readonly siteCode: string;
  readonly runIds: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly checkpointTs: readonly number[];
  /** 탐지기별 적용 설비 수 */
  readonly applicableAssets: Readonly<Record<string, number>>;
  readonly detections: readonly DetectionRecord[];
  readonly injections: readonly InjectionResult[];
  readonly related: readonly RelatedWindow[];
  readonly controls: readonly ControlEventTruth[];
  readonly tallies: readonly OutcomeTally[];
  /** ess.capacity_fade 점검 시각별 설비 판정 상태 */
  readonly capacityStatuses: readonly CheckpointStatus[];
  readonly stats: SiteJobStats;
}
