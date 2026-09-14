// 시뮬레이터 평가 결과 타입 (잡 → 워커 → 집계). 모두 JSON으로 주고받을 수 있는 값이다.
import type { ControlEventTruth, InjectionTruth } from '../truth';

/** 메모리 모드에서 평가하는 탐지기 (dq.gap_flatline은 전송 계층 효과가 없어 DB E2E 모드에서만 평가) */
export const EVAL_DETECTOR_IDS = ['ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay'] as const;
export type EvalDetectorId = (typeof EVAL_DETECTOR_IDS)[number];

/** 탐지기가 적용되는 설비 종류 */
export const EVAL_DETECTOR_CLASS: Readonly<Record<EvalDetectorId, string>> = {
  'ess.capacity_fade': 'ess.rack',
  'ess.cell_imbalance': 'ess.rack',
  'pv.inverter_peer': 'pv.inverter',
  'el.voltage_rise': 'h2.elz.stack',
  'fc.voltage_decay': 'fc.stack',
};

export interface EvidenceWindows {
  readonly referenceFrom: number;
  readonly referenceTo: number;
  readonly recentFrom: number;
  readonly recentTo: number;
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
  readonly controls: readonly ControlEventTruth[];
  readonly tallies: readonly OutcomeTally[];
  readonly stats: SiteJobStats;
}
