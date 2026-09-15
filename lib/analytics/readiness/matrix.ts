// 탐지 준비도 셀 판정 (순수): 설비 × 탐지기(고장모드) → ready | partial | missing | n/a.
//   n/a      요구 설비 종류가 있고 이 설비 종류가 거기에 없음
//   missing  필수 메트릭 중 포인트가 없는 것이 있음 (missingMetrics)
//   partial  메트릭은 모두 있으나 한 가지 이상: 완결성 < minCompleteness(null은 0) · 포인트 주기 > minPeriodS · 이력 < minHistoryDays
//   ready    그 밖
// 같은 메트릭 포인트가 여러 개(한정자)면 완결성이 높은 것 → 주기가 짧은 것 → 이력이 긴 것을 쓴다.
// 셀 이력 = 쓰는 포인트 이력의 최솟값. 필수 메트릭이 없는 탐지기는 설비 포인트 이력의 최댓값(포인트가 없으면 0)이다.
import { READINESS_DEFAULTS, type DetectorRequirement, type PartialReason, type ReadinessAsset, type ReadinessCell, type ReadinessParams, type ReadinessPoint, type ReadinessSummary } from './types';

const DEFAULT_SEVERITY = 1;

function bestPoint(points: readonly ReadinessPoint[], metricKey: string): ReadinessPoint | null {
  const candidates = points.filter((p) => p.metricKey === metricKey);
  const rank = (p: ReadinessPoint) => p.completeness ?? -1;
  return candidates.reduce<ReadinessPoint | null>((best, p) => {
    if (best === null) return p;
    if (rank(p) !== rank(best)) return rank(p) > rank(best) ? p : best;
    if (p.periodS !== best.periodS) return p.periodS < best.periodS ? p : best;
    return p.historyDays > best.historyDays ? p : best;
  }, null);
}

export const appliesTo = (requirement: DetectorRequirement, classKey: string): boolean =>
  requirement.assetClass.length === 0 || requirement.assetClass.includes(classKey);

function pointReasons(metricKey: string, point: ReadinessPoint, requirement: DetectorRequirement, params: ReadinessParams): PartialReason[] {
  const reasons: PartialReason[] = [];
  if ((point.completeness ?? 0) < params.minCompleteness) reasons.push({ code: 'low_completeness', metricKey, completeness: point.completeness, required: params.minCompleteness });
  if (requirement.minPeriodS !== null && point.periodS > requirement.minPeriodS) reasons.push({ code: 'coarse_period', metricKey, periodS: point.periodS, requiredS: requirement.minPeriodS });
  return reasons;
}

export function readinessCell(asset: ReadinessAsset, requirement: DetectorRequirement, params: ReadinessParams = READINESS_DEFAULTS): ReadinessCell {
  const base = {
    assetId: asset.id,
    assetCode: asset.code,
    assetClass: asset.classKey,
    detectorId: requirement.detectorId,
    failureMode: requirement.failureMode,
    severity: requirement.severity ?? DEFAULT_SEVERITY,
  };
  if (!appliesTo(requirement, asset.classKey)) return { ...base, status: 'n/a', missingMetrics: [], reasons: [] };

  const found = requirement.metrics.map((metricKey) => ({ metricKey, point: bestPoint(asset.points, metricKey) }));
  const missingMetrics = found.filter((f) => f.point === null).map((f) => f.metricKey);
  const present = found.flatMap((f) => (f.point === null ? [] : [{ metricKey: f.metricKey, point: f.point }]));
  const historyDays =
    requirement.metrics.length === 0
      ? Math.max(0, ...asset.points.map((p) => p.historyDays))
      : present.length === 0
        ? 0
        : Math.min(...present.map((f) => f.point.historyDays));
  const shortHistory = (present.length > 0 || requirement.metrics.length === 0) && historyDays < requirement.minHistoryDays;
  const reasons: PartialReason[] = [
    ...present.flatMap((f) => pointReasons(f.metricKey, f.point, requirement, params)),
    ...(shortHistory ? [{ code: 'short_history' as const, historyDays, requiredDays: requirement.minHistoryDays }] : []),
  ];
  const status = missingMetrics.length > 0 ? 'missing' : reasons.length > 0 ? 'partial' : 'ready';
  return { ...base, status, missingMetrics, reasons };
}

const byCode = (a: ReadinessAsset, b: ReadinessAsset): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** 설비(경로순) × 탐지기(입력 순서) 전체 셀 */
export function readinessMatrix(assets: readonly ReadinessAsset[], requirements: readonly DetectorRequirement[], params: Partial<ReadinessParams> = {}): ReadinessCell[] {
  const resolved = { ...READINESS_DEFAULTS, ...params };
  if (!(resolved.minCompleteness >= 0 && resolved.minCompleteness <= 1)) throw new RangeError(`준비도: minCompleteness는 0~1이어야 합니다 (${resolved.minCompleteness})`);
  return [...assets].sort(byCode).flatMap((asset) => requirements.map((requirement) => readinessCell(asset, requirement, resolved)));
}

export function readinessSummary(cells: readonly ReadinessCell[]): ReadinessSummary {
  const count = (status: ReadinessCell['status']) => cells.filter((c) => c.status === status).length;
  const notApplicable = count('n/a');
  const applicable = cells.length - notApplicable;
  const ready = count('ready');
  return {
    total: cells.length,
    applicable,
    ready,
    partial: count('partial'),
    missing: count('missing'),
    notApplicable,
    readyRatio: applicable > 0 ? ready / applicable : null,
  };
}
