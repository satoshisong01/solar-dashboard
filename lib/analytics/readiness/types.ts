// 탐지 준비도 매트릭스 입력·출력 타입 (설계 §4 /data/readiness, §4.1 "이 메트릭을 확보하면 풀리는 고장모드 수"). 순수 모듈.
// 탐지기 레지스트리는 import하지 않는다 — 레지스트리의 requires를 DetectorRequirement로 옮겨 넣는 연결은 다음 단계가 맡는다.

/** 탐지기(고장모드) 하나의 데이터 요구 조건 */
export interface DetectorRequirement {
  readonly detectorId: string;
  readonly failureMode: string;
  /** 적용 설비 종류. 빈 배열이면 모든 설비에 적용한다 (예: dq.gap_flatline) */
  readonly assetClass: readonly string[];
  /** 필수 메트릭 키 */
  readonly metrics: readonly string[];
  /** 허용하는 가장 긴 포인트 주기 [s]. 포인트 period_s가 이보다 길면 partial */
  readonly minPeriodS: number;
  /** 필요한 데이터 이력 [일] */
  readonly minHistoryDays: number;
  /** 고장모드 심각도 1~5 (메트릭 확보 순위 동률 가중). 없으면 1 */
  readonly severity?: number;
}

/** 설비가 가진 포인트 하나 (om.point + 최근 30일 수집 통계) */
export interface ReadinessPoint {
  readonly metricKey: string;
  readonly periodS: number;
  /** 최근 30일 완결성 0~1. 30일 동안 샘플이 없으면 null (0으로 본다) */
  readonly completeness: number | null;
  /** 첫 샘플부터 지금까지 [일] */
  readonly historyDays: number;
}

/**
 * 준비도를 볼 설비. points에는 탐지기가 그 설비를 분석할 때 끌어 쓰는 관련 설비 포인트
 * (상위 설비·형제 설비·사이트 기상 설비, lib/analytics/pipeline/sources.ts 규칙)를 합쳐 넣는다.
 */
export interface ReadinessAsset {
  readonly id: number;
  /** 사이트 안 경로 (예: ESS1/RACK01) */
  readonly code: string;
  readonly classKey: string;
  readonly points: readonly ReadinessPoint[];
}

export interface ReadinessParams {
  /** 이 완결성 미만이면 partial (기본 0.9) */
  readonly minCompleteness: number;
}

export const READINESS_DEFAULTS: ReadinessParams = Object.freeze({ minCompleteness: 0.9 });

/** ready: 조건 충족 / partial: 메트릭은 있으나 완결성·주기·이력 부족 / missing: 필수 메트릭 없음 / n/a: 설비 종류 무관 */
export type ReadinessStatus = 'ready' | 'partial' | 'missing' | 'n/a';

export type PartialReason =
  | { readonly code: 'low_completeness'; readonly metricKey: string; readonly completeness: number | null; readonly required: number }
  | { readonly code: 'coarse_period'; readonly metricKey: string; readonly periodS: number; readonly requiredS: number }
  | { readonly code: 'short_history'; readonly historyDays: number; readonly requiredDays: number };

export interface ReadinessCell {
  readonly assetId: number;
  readonly assetCode: string;
  readonly assetClass: string;
  readonly detectorId: string;
  readonly failureMode: string;
  readonly severity: number;
  readonly status: ReadinessStatus;
  /** 없는 필수 메트릭 (status = missing일 때만 비어 있지 않다) */
  readonly missingMetrics: readonly string[];
  /** 있는 메트릭의 부족 사유 (missing 셀에도 참고로 남긴다) */
  readonly reasons: readonly PartialReason[];
}

export interface ReadinessSummary {
  readonly total: number;
  /** n/a를 뺀 셀 수 */
  readonly applicable: number;
  readonly ready: number;
  readonly partial: number;
  readonly missing: number;
  readonly notApplicable: number;
  /** ready / applicable (적용 셀이 없으면 null) */
  readonly readyRatio: number | null;
}

/** 메트릭 하나를 확보했을 때 풀리는 셀 */
export interface MetricAcquisition {
  readonly metricKey: string;
  /** 이 메트릭만 없어서 missing인 (설비 × 탐지기) 수 — 확보하면 ready 또는 partial이 된다 */
  readonly unlocks: number;
  /** unlocks 셀의 심각도 합 (동률 정렬 기준) */
  readonly severityWeight: number;
  /** 이 메트릭이 누락 목록에 들어 있는 missing 셀 수 (다른 메트릭도 함께 없는 셀 포함) */
  readonly blockedCells: number;
}
