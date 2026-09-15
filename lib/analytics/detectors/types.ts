// 탐지기 인터페이스 (설계 §5.3). detect는 순수 함수다 — 입력 로드(I/O)는 다음 단계의 load 계층이 맡는다.
import type { ZodObject, ZodRawShape, ZodType } from 'zod';
import type { JsonObject, RandomSource, TimeWindow } from '../types';

/** om.finding.category CHECK와 같다 */
export type FindingCategory = 'performance' | 'degradation' | 'data_quality' | 'safety' | 'availability';

export type Severity = 1 | 2 | 3 | 4 | 5;

/** P2 탐지기 6종 + P3 탐지기 8종이 내는 고장모드 (플레이북 키) */
export type FailureMode =
  | 'ess.capacity_fade'
  | 'ess.cell_imbalance'
  | 'pv.inverter_underperformance'
  | 'el.stack_voltage_degradation'
  | 'fc.stack_voltage_decay'
  | 'dq.data_gap_flatline'
  | 'el.system_efficiency_loss'
  | 'h2chain.mass_balance_gap'
  | 'h2.storage_leak'
  | 'comp.efficiency_loss'
  | 'fc.blower_wear'
  | 'pv.soiling'
  | 'ess.resistance_growth'
  | 'pv.inverter_thermal_derating';

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

/** 탐지기 파라미터 스키마: 출력 타입이 P인 zod 객체 스키마 */
export type ParamSchema<P> = ZodObject<ZodRawShape> & ZodType<P>;

/** 탐지 준비도 매트릭스가 쓰는 입력 요건 */
export interface DetectorRequirements {
  /** 탐지 대상 설비 종류. 사이트 단위 탐지기는 사이트에 있어야 하는 설비 종류 전부 */
  readonly assetClass: readonly string[];
  /** 필수 메트릭 (대상 설비와, 입력에 합쳐 넣는 상위·형제·사이트 설비의 메트릭). 판별 체크에만 쓰는 보조 메트릭은 넣지 않는다 */
  readonly metrics: readonly string[];
  /** 필요한 샘플 주기 상한 [s]: 필수 메트릭 포인트의 period_s가 이 값 이하여야 한다. null이면 주기와 무관 */
  readonly minPeriodS: number | null;
  /** 판정에 필요한 최소 데이터 기간 [일] (기준선 재설정 이후) */
  readonly minHistoryDays: number;
}

export interface Detector<I, P = Record<string, number | boolean | null>> {
  readonly id: string;
  readonly version: string;
  readonly failureMode: FailureMode;
  readonly category: FindingCategory;
  readonly requires: DetectorRequirements;
  readonly defaultParams: P;
  /**
   * detector_config.params 스키마. 필드마다 기본값(= defaultParams)·min·max와 meta({ label, unit, description })가 있다.
   * 설정 UI는 z.toJSONSchema(paramSchema)로 폼을 만들고, 저장 전 paramSchema.partial()로 검증한다.
   */
  readonly paramSchema: ParamSchema<P>;
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
