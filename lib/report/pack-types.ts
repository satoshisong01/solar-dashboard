// EvidencePack om.evidence-pack.v1 (설계 §5.4): 리포트 문장을 만들 때 쓰는 유일한 입력. 순수 타입 모듈.
// 무엇을 말할지(항목·수치·우선순위·판정)는 팩을 만드는 결정적 엔진(evidence-pack.ts·planner.ts)이 정하고,
// 어떻게 말할지만 ReportComposer가 정한다. 원시 시계열은 넣지 않는다 — 근거 요약 시계열(≤120점)만.
import type { CapacityMetric } from '@/lib/desk/conditions';

export const EVIDENCE_PACK_SCHEMA = 'om.evidence-pack.v1';
/** 팩 조립·우선순위 규칙 버전. 규칙을 바꾸면 올린다 (같은 입력 → 같은 팩 해시) */
export const REPORT_ENGINE_VERSION = 'report-planner@1';
/** 근거 요약 시계열 점 수 상한 (finding_evidence 다운샘플과 같다) */
export const MAX_EVIDENCE_POINTS = 120;

export type ReportPeriodKind = 'month' | 'quarter' | 'custom';

export interface PackPeriod {
  readonly kind: ReportPeriodKind;
  /** [from, to) epoch ms (KST 날짜 경계) */
  readonly from: number;
  readonly to: number;
  /** '2026년 9월' · '2026년 3분기' · '2026-08-01 ~ 2026-08-31' */
  readonly label: string;
  /** 기간 마지막 날 0시 (KST, 표시용) */
  readonly lastDay: number;
}

export interface PackSite {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

export interface PackEffect {
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly levelUnit: string | null;
}

export type SeriesXKind = 'time' | 'op_hours' | 'elapsed_days';

export interface PackSeries {
  readonly xKind: SeriesXKind;
  readonly yName: string;
  readonly points: readonly (readonly [number, number])[];
  /** 추세선 두 끝점 (없으면 null) */
  readonly line: readonly (readonly [number, number])[] | null;
}

export interface PackCheck {
  readonly label: string;
  readonly status: 'supports' | 'refutes' | 'unknown' | 'no_data';
}

export interface CapacityPackEvidence {
  readonly kind: 'capacity';
  readonly metric: CapacityMetric;
  readonly nRef: number;
  readonly nCur: number;
  /** 비교에 쓴 bin 범위 (하한 ~ 상한+폭) */
  readonly cRateLow: number | null;
  readonly cRateHigh: number | null;
  readonly tempLowC: number | null;
  readonly tempHighC: number | null;
  readonly anchorSocMaxPct: number;
  readonly minCcSocSpanPct: number;
  readonly minSocSpanPct: number;
  /** 휴지 앵커 규칙: 휴지 최소 [분]·SOC 변화 하한 [%p] */
  readonly restMinutes: number;
  readonly minDeltaSocRestPct: number;
  /** 근거 주의 코드 (예: SOC 기반 추정은 BMS SOC 재보정 품질에 의존) */
  readonly cautions: readonly string[];
  readonly referenceCurrentA: number | null;
  readonly baselineHours: number | null;
  readonly currentHours: number | null;
  readonly slopePerMonth: number | null;
  readonly slopeCiLow: number | null;
  readonly slopeCiHigh: number | null;
  readonly sohTargetPct: number | null;
  /** 외삽 가드를 통과했을 때만 날짜 (lib/desk/projection.ts) */
  readonly sohTargetDate: number | null;
  /** 가드를 통과하지 못했으면 추세 데이터 기간 [일] ("추세 확인 중(데이터 N일)"), 통과했거나 추세가 없으면 null */
  readonly sohProjectionPendingDays: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface StackPackEvidence {
  readonly kind: 'stack';
  /** 효과 기울기 구간 (post_change면 opHoursFirst = 변화점) */
  readonly slopeBasis: 'full' | 'post_change';
  /** 전체 점 기울기 [µV/h] (부호 포함) */
  readonly fullSlopeUvPerH: number | null;
  readonly segments: number;
  readonly binCount: number;
  readonly breakInHours: number | null;
  readonly opHoursFirst: number | null;
  readonly opHoursLast: number | null;
  readonly opHoursSpan: number | null;
  /** 처음 → 마지막 추세 수준 차이 절댓값 [mV] */
  readonly deltaMv: number | null;
  readonly slopeUvPerH: number | null;
  readonly slopeCiLow: number | null;
  readonly slopeCiHigh: number | null;
  readonly series: PackSeries | null;
  readonly checks: readonly PackCheck[];
}

export interface CellImbalancePackEvidence {
  readonly kind: 'cell_imbalance';
  readonly source: 'charge_end' | 'rest';
  readonly nRef: number;
  readonly nCur: number;
  readonly slopeMvPerMonth: number | null;
  readonly slopeCiLow: number | null;
  readonly slopeCiHigh: number | null;
  readonly peerCount: number;
  readonly peerZ: number | null;
  readonly spanDays: number | null;
  readonly series: PackSeries | null;
}

export interface PvPeerPackEvidence {
  readonly kind: 'pv_peer';
  readonly days: number;
  readonly flaggedDays: number;
  readonly peers: number;
  readonly excludedDays: number;
  readonly series: PackSeries | null;
}

export interface DqPackEvidence {
  readonly kind: 'dq';
  readonly pointCount: number;
  readonly gapPoints: number;
  readonly flatlinePoints: number;
  readonly worstCompletenessPct: number | null;
  readonly longestGapHours: number | null;
  readonly longestFlatlineHours: number | null;
}

export type PackEvidence = CapacityPackEvidence | StackPackEvidence | CellImbalancePackEvidence | PvPeerPackEvidence | DqPackEvidence | { readonly kind: 'unknown' };

export type DataSpanUnit = 'days' | 'op_hours';

export interface DataSpan {
  readonly value: number;
  readonly unit: DataSpanUnit;
}

/** 확정: 신뢰도·반복 탐지 충분 / 잠정: 판정했지만 근거가 약함 / 판정 보류: 최소 데이터 기간 미달 (관찰 중) */
export type Judgement = 'confirmed' | 'provisional' | 'hold';

export interface PackPlaybook {
  readonly title: string;
  readonly actions: readonly string[];
  readonly inspections: readonly string[];
  readonly falsePositiveTraps: readonly string[];
}

export interface PackTransition {
  readonly from: string | null;
  readonly to: string;
  readonly at: number;
  readonly actor: string;
}

export interface PackHistory {
  readonly firstDetectedAt: number;
  readonly lastDetectedAt: number;
  readonly detectionCount: number;
  readonly previousFindingId: string | null;
  /** 최근 전이 (최대 10건, 오래된 순) */
  readonly transitions: readonly PackTransition[];
  readonly actions: readonly { readonly id: string; readonly actionType: string; readonly performedAt: number }[];
}

export interface PackFinding {
  readonly id: string;
  readonly assetId: number | null;
  /** 설비 경로 (사이트 단위면 사이트 코드) */
  readonly assetPath: string;
  readonly assetCriticality: number | null;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly detectorLabel: string;
  readonly failureMode: string;
  readonly category: string;
  readonly title: string;
  readonly severity: number;
  /** 0~1 */
  readonly confidence: number;
  readonly status: string;
  readonly effect: PackEffect;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly evidenceId: string | null;
  readonly evidenceComputedAt: number | null;
  readonly evidence: PackEvidence;
  readonly playbook: PackPlaybook | null;
  readonly history: PackHistory;
  readonly dataSpan: DataSpan | null;
  readonly minDataSpan: DataSpan | null;
  readonly judgement: Judgement;
  /** 추정 영향 (효과 크기 정규화 × 설비 중요도, 단위 없음) */
  readonly impact: number;
  /** 심각도 × 신뢰도 × 추정 영향 */
  readonly priority: number;
}

export interface PackTodo {
  readonly rank: number;
  readonly findingId: string;
  readonly findingIndex: number;
  readonly action: string;
}

export interface PackKpi {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly scope: 'site' | 'assets';
  readonly assetCount: number;
  /** 값이 있는 날 수 */
  readonly days: number;
  /** 합계 (더할 수 있는 지표만, 아니면 null) */
  readonly total: number | null;
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
  /** 데이터 완결성 평균 [%] */
  readonly completenessPct: number | null;
}

export interface PackKpiAsset {
  readonly key: string;
  readonly assetPath: string;
  readonly days: number;
  readonly mean: number | null;
  readonly completenessPct: number | null;
}

export interface PackEnergy {
  readonly pvKwh: number | null;
  readonly essChargeKwh: number | null;
  readonly essDischargeKwh: number | null;
  readonly h2Kg: number | null;
  readonly fcKwh: number | null;
}

export interface PackLowCompleteness {
  readonly key: string;
  readonly label: string;
  readonly assetPath: string;
  readonly completenessPct: number;
  readonly days: number;
}

export interface PackDataQuality {
  readonly completenessThresholdPct: number;
  readonly lowCompleteness: readonly PackLowCompleteness[];
  /** 포함한 데이터 품질 발견사항 id */
  readonly findingIds: readonly string[];
}

export interface PackVerifiedAction {
  readonly verificationId: string;
  readonly actionId: string;
  readonly findingId: string | null;
  readonly assetPath: string;
  readonly actionType: string;
  readonly performedAt: number;
  readonly metric: string;
  readonly metricLabel: string;
  readonly unit: string;
  readonly verdict: 'improved' | 'no_change' | 'worse' | 'insufficient_data';
  readonly effect: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly beforeN: number;
  readonly afterN: number;
  readonly computedAt: number;
}

export interface PackRevenue {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly days: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

export interface PackStats {
  readonly findingCount: number;
  readonly severeThreshold: number;
  readonly severeCount: number;
  readonly holdCount: number;
  readonly verifiedActionCount: number;
  readonly improvedCount: number;
}

export interface PackSelection {
  readonly findingIds: readonly string[];
  readonly includeVerifiedActions: boolean;
  /** "새 초안 만들기"로 만든 초안이면 바탕 리포트 id (근거가 같아도 새 초안이 되고, 대체 체인을 남긴다) */
  readonly basedOnReportId: string | null;
}

export interface PackProvenance {
  readonly schema: typeof EVIDENCE_PACK_SCHEMA;
  readonly engineVersion: string;
  readonly kpiCalcVersion: string;
  readonly detectorVersions: readonly string[];
  /** 만든 시각. 팩 해시에는 넣지 않는다 */
  readonly generatedAt: number;
  readonly packHash: string;
}

export interface EvidencePack {
  readonly schema: typeof EVIDENCE_PACK_SCHEMA;
  readonly site: PackSite;
  readonly period: PackPeriod;
  readonly selection: PackSelection;
  readonly stats: PackStats;
  readonly energySummary: PackEnergy;
  readonly kpis: readonly PackKpi[];
  readonly kpiByAsset: readonly PackKpiAsset[];
  /** 심각도 내림차순 → 우선순위 내림차순 → id */
  readonly findings: readonly PackFinding[];
  readonly todo: readonly PackTodo[];
  readonly dataQuality: PackDataQuality;
  readonly verifiedActions: readonly PackVerifiedAction[];
  readonly revenueSummary: readonly PackRevenue[];
  readonly provenance: PackProvenance;
}
