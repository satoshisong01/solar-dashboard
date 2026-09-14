// 탐지기 인터페이스 (설계 §5.3). detect는 순수 함수다 — 입력 로드(I/O)는 다음 단계의 load 계층이 맡는다.
import type { JsonObject, RandomSource, TimeWindow } from '../types';

/** om.finding.category CHECK와 같다 */
export type FindingCategory = 'performance' | 'degradation' | 'data_quality' | 'safety' | 'availability';

export type Severity = 1 | 2 | 3 | 4 | 5;

/** P2 탐지기 6종이 내는 고장모드 (플레이북 키) */
export type FailureMode =
  | 'ess.capacity_fade'
  | 'ess.cell_imbalance'
  | 'pv.inverter_underperformance'
  | 'el.stack_voltage_degradation'
  | 'fc.stack_voltage_decay'
  | 'dq.data_gap_flatline';

/** om.asset_event (kind CHECK와 같은 값) */
export interface AssetEventInput {
  readonly ts: number;
  readonly kind: 'replacement' | 'firmware' | 'setpoint_change' | 'maintenance' | 'calibration' | 'other';
  readonly resetsBaseline: boolean;
  readonly note?: string | null;
}

export interface DetectorContext<P> {
  readonly now: number;
  readonly rng: RandomSource;
  /** detector_config.params. 빠진 키는 탐지기 defaultParams로 채운다 */
  readonly params: Partial<P>;
  /** detector_config.reference_window */
  readonly referenceWindow?: TimeWindow;
  /** 가장 최근 asset_event(resets_baseline) 시각. 이 시각 이전 데이터는 기준선에 쓰지 않는다 */
  readonly baselineResetAt?: number;
}

export interface FindingEffect {
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  /** 기준·현재 수준 (단위는 levelUnit) */
  readonly baseline: number | null;
  readonly current: number | null;
  readonly levelUnit: string | null;
}

export interface CandidateFinding {
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly assetId: number | null;
  readonly failureMode: FailureMode;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly confidence: number;
  readonly title: string;
  readonly summary: string;
  readonly effect: FindingEffect;
  readonly windowStart: number;
  readonly windowEnd: number;
  /** finding_evidence.snapshot: bin 표·추세 점·오버레이 등 (시계열은 ≤ 120점) */
  readonly evidence: JsonObject;
  readonly inputHash: string;
}

export type DetectorResult =
  | { readonly status: 'ok'; readonly findings: readonly CandidateFinding[] }
  | { readonly status: 'insufficient'; readonly reason: string };

export interface DetectorRequirements {
  readonly assetClass: readonly string[];
  readonly metrics: readonly string[];
}

export interface Detector<I, P = Record<string, number | boolean | null>> {
  readonly id: string;
  readonly version: string;
  readonly failureMode: FailureMode;
  readonly category: FindingCategory;
  readonly requires: DetectorRequirements;
  readonly defaultParams: P;
  detect(input: I, ctx: DetectorContext<P>): DetectorResult;
}

/** 원인 판별 체크 결과 */
export type CheckStatus = 'supports' | 'refutes' | 'unknown' | 'no_data';

export type DiagnosticCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly measured: JsonObject;
  readonly note: string;
};
