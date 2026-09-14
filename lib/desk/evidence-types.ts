// 근거 스냅샷(finding_evidence.snapshot) 표시 모델. 순수 타입 모듈 (서버·클라이언트 공용).
// 서버가 evidence.ts로 jsonb를 이 형태로 읽어 클라이언트 차트에 넘긴다.
import type { CheckStatus } from '@/lib/analytics/detectors/types';
import type { BinWidths, CapacityBinView, CapacityMetric, SessionRules } from './conditions';
import type { ChargeCurve } from './overlay';
import type { TrendView } from './trend';

export type MeasuredValue = number | string | boolean | null;

export interface CheckView {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** [표시 이름, 값] */
  readonly measured: readonly (readonly [string, MeasuredValue])[];
  readonly note: string;
}

export interface WindowView {
  readonly n: number;
  readonly from: number | null;
  readonly to: number | null;
}

export interface SohTargetView {
  readonly pct: number;
  readonly estimate: number | null;
  readonly early: number | null;
  readonly late: number | null;
}

export interface CapacityEvidence {
  readonly kind: 'capacity';
  readonly metric: CapacityMetric;
  readonly widths: BinWidths;
  readonly rules: SessionRules;
  readonly bins: readonly CapacityBinView[];
  readonly reference: WindowView;
  readonly recent: WindowView;
  readonly trend: TrendView | null;
  readonly sohTarget: SohTargetView | null;
  readonly referenceCurrentA: number | null;
  readonly overlay: { readonly reference: ChargeCurve | null; readonly recent: ChargeCurve | null };
  readonly checks: readonly CheckView[];
}

export interface StackBinView {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  readonly medianMv: number | null;
  readonly opHMin: number | null;
  readonly opHMax: number | null;
}

export interface StackEvidence {
  readonly kind: 'stack';
  readonly breakInHours: number | null;
  readonly excludedBreakIn: number | null;
  readonly bins: readonly StackBinView[];
  readonly trend: TrendView | null;
  readonly checks: readonly CheckView[];
}

export interface CellImbalanceEvidence {
  readonly kind: 'cell_imbalance';
  readonly source: string;
  readonly reference: { readonly n: number; readonly medianMv: number | null };
  readonly recent: { readonly n: number; readonly medianMv: number | null };
  readonly trend: TrendView | null;
  readonly peers: { readonly modifiedZ: number | null; readonly values: readonly { readonly assetId: number; readonly dvMv: number | null }[] };
}

export interface PvPeerDay {
  readonly day: string;
  readonly kwhPerKwp: number | null;
  readonly peerMedian: number | null;
  readonly deviationPct: number | null;
  readonly modifiedZ: number | null;
  readonly peers: number | null;
  readonly flagged: boolean;
}

export interface PvPeerEvidence {
  readonly kind: 'pv_peer';
  readonly days: readonly PvPeerDay[];
  readonly excludedDays: number | null;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface DqPointView {
  readonly pointId: number;
  readonly sourceKey: string;
  readonly metricKey: string;
  readonly completeness: number | null;
  readonly gapHours: number | null;
  readonly gaps: readonly Span[];
  readonly longestFlatlineHours: number | null;
  readonly flatlines: readonly Span[];
}

export interface DqEvidence {
  readonly kind: 'dq';
  readonly points: readonly DqPointView[];
  readonly gapPoints: number | null;
  readonly flatlinePoints: number | null;
}

export type EvidenceView = CapacityEvidence | StackEvidence | CellImbalanceEvidence | PvPeerEvidence | DqEvidence | { readonly kind: 'unknown' };
