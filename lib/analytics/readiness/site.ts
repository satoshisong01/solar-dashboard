// 사이트 하나의 탐지 준비도 행 조립 (순수): 설비 트리 + 포인트 수집 통계 → 설비(행) × 탐지기(열) 셀.
//   사이트 행     finding이 사이트 단위인 탐지기(targets.ts findingUnit = site)만 판정한다. 포인트 = 요구 설비 종류 설비들의 포인트 전부.
//                 요구 설비 종류가 사이트에 하나도 없으면 n/a (예: 태양광+ESS 사이트의 수소 물질수지).
//   설비 행       대상 종류(targetClass)가 같은 탐지기만 판정한다. 포인트 = 자기 포인트 전부 + 분석이 합쳐 쓰는 관련 설비 포인트
//                 (pipeline/sources.ts 에피소드 입력 규칙 + 아래 READINESS_EXTRA_SOURCES). 대상 종류가 없는 탐지기(dq.gap_flatline)는
//                 포인트가 있는 모든 설비에 적용한다. 포인트도 없고 대상도 아닌 설비(발전소 묶음 설비 등)는 행을 만들지 않는다.
// 한정자 포인트('valve.open#inlet')는 메트릭 키만으로 요구 조건과 맞춘다. 같은 키가 여럿이면 matrix.ts가 가장 좋은 포인트를 쓴다.
import { seriesRequests } from '../pipeline/sources';
import { targetingOf } from '../pipeline/targets';
import type { PipelineAsset } from '../pipeline/types';
import { readinessCell } from './matrix';
import { READINESS_DEFAULTS, type DetectorRequirement, type ReadinessCell, type ReadinessParams, type ReadinessPoint } from './types';

/** 사이트 행의 설비 id·경로·종류 (셀 CSV에 그대로 나간다) */
export const SITE_ROW_ID = 0;
export const SITE_ROW_CODE = '(사이트 전체)';
export const SITE_ROW_CLASS = 'site';

/** 포인트 하나의 수집 통계. metricKey는 loadSitePoints 형식(한정자가 있으면 'metric#qualifier') */
export interface SitePointStat {
  readonly assetId: number;
  readonly metricKey: string;
  readonly periodS: number;
  readonly completeness: number | null;
  readonly historyDays: number;
}

/** 포인트 수집 통계 원자료 (om.point + 최근 창 m_1h 합계) */
export interface PointCounts {
  readonly assetId: number;
  readonly metricKey: string;
  readonly periodS: number | null;
  /** 첫 1시간 롤업 버킷 (epoch ms). 데이터가 없으면 null */
  readonly firstMs: number | null;
  /** 창 [now − windowDays, now) 안의 good 샘플 수·전체 샘플 수·데이터가 있는 시간 수 */
  readonly nGood: number;
  readonly n: number;
  readonly hours: number;
}

/**
 * 완결성 = 창 good 샘플 / 기대 샘플. 기대 샘플은 max(첫 데이터, 창 시작)부터 now까지 (새 포인트의 짧은 이력은 완결성이 아니라 이력 조건이 드러낸다).
 * 창 안에 샘플이 하나도 없으면 null(데이터 없음). 이력 = now − 첫 데이터 [일, 내림]. 포인트 주기가 없으면 창 샘플 밀도(시간당 샘플 수)로 추정하고, 데이터도 없으면 0(알 수 없음, 완결성 사유만 남는다).
 */
export function pointStatOf(counts: PointCounts, nowMs: number, windowDays: number): SitePointStat {
  const dayMs = 86_400_000;
  const periodS = counts.periodS ?? (counts.n > 0 && counts.hours > 0 ? Math.round(3600 / (counts.n / counts.hours)) : 0);
  const historyDays = counts.firstMs === null ? 0 : Math.max(0, Math.floor((nowMs - counts.firstMs) / dayMs));
  const expectedFrom = counts.firstMs === null ? null : Math.max(counts.firstMs, nowMs - windowDays * dayMs);
  const expected = expectedFrom === null || periodS <= 0 ? 0 : (nowMs - expectedFrom) / (periodS * 1000);
  const completeness = counts.n > 0 && expected > 0 ? Math.min(1, Math.max(0, counts.nGood / expected)) : null;
  return { assetId: counts.assetId, metricKey: counts.metricKey, periodS, completeness, historyDays };
}

export interface ReadinessRow {
  readonly assetId: number;
  readonly code: string;
  readonly classKey: string;
  readonly cells: readonly ReadinessCell[];
}

/**
 * 에피소드 입력 규칙(sources.ts)에는 없지만 탐지기 보조 입력(lib/analysis/aux-inputs.ts)이 사이트 설비에서 끌어 쓰는 메트릭.
 * 실제 로더는 형제·상위 설비를 정확히 찾지만 여기서는 사이트 안 같은 종류 첫 설비로 근사한다 (설비가 하나뿐인 구성 기준).
 */
export const READINESS_EXTRA_SOURCES: Readonly<Record<string, readonly { readonly classKey: string; readonly metrics: readonly string[] }[]>> = {
  'pv.inverter': [{ classKey: 'wx.station', metrics: ['ambient.temp'] }], // inv.thermal_derating 외기 온도
  'h2.elz.stack': [
    { classKey: 'h2.elz.rectifier', metrics: ['rectifier.efficiency'] }, // el.sec_rise 판별 체크 ② 정류기 효율
    { classKey: 'h2.elz', metrics: ['purge.count'] }, // el.sec_rise 판별 체크 ③ 퍼지 횟수
  ],
};

const baseMetric = (metricKey: string): string => metricKey.split('#')[0] as string;
const byCode = <T extends { readonly code: string }>(a: T, b: T): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const toReadinessPoint = (p: SitePointStat): ReadinessPoint => ({ metricKey: baseMetric(p.metricKey), periodS: p.periodS, completeness: p.completeness, historyDays: p.historyDays });

function naCell(assetId: number, code: string, classKey: string, requirement: DetectorRequirement): ReadinessCell {
  return { assetId, assetCode: code, assetClass: classKey, detectorId: requirement.detectorId, failureMode: requirement.failureMode, severity: requirement.severity ?? 1, status: 'n/a', missingMetrics: [], recommendedMissing: [], reasons: [] };
}

/** 설비 행 판정에 쓰는 포인트: 자기 포인트 + 관련 설비(상위·형제·사이트)의 요청 메트릭 포인트 */
export function relatedPoints(asset: PipelineAsset, siteAssets: readonly PipelineAsset[], points: readonly SitePointStat[]): SitePointStat[] {
  const own = points.filter((p) => p.assetId === asset.id);
  const extraAssets = (READINESS_EXTRA_SOURCES[asset.classKey] ?? []).flatMap((source) => {
    const related = siteAssets.filter((a) => a.siteId === asset.siteId && a.classKey === source.classKey).sort(byCode)[0];
    return related ? source.metrics.map((metricKey) => ({ assetId: related.id, metricKey })) : [];
  });
  const requests = [...seriesRequests(asset, siteAssets).filter((r) => r.assetId !== asset.id), ...extraAssets];
  const borrowed = points.filter((p) => requests.some((r) => r.assetId === p.assetId && r.metricKey === p.metricKey));
  return [...own, ...borrowed];
}

function siteRow(assets: readonly PipelineAsset[], points: readonly SitePointStat[], requirements: readonly DetectorRequirement[], params: ReadinessParams): ReadinessRow {
  const cells = requirements.map((requirement) => {
    if (targetingOf(requirement.detectorId)?.findingUnit !== 'site') return naCell(SITE_ROW_ID, SITE_ROW_CODE, SITE_ROW_CLASS, requirement);
    const members = new Set(assets.filter((a) => requirement.assetClass.includes(a.classKey)).map((a) => a.id));
    if (members.size === 0) return naCell(SITE_ROW_ID, SITE_ROW_CODE, SITE_ROW_CLASS, requirement);
    const sitePoints = points.filter((p) => members.has(p.assetId)).map(toReadinessPoint);
    return readinessCell({ id: SITE_ROW_ID, code: SITE_ROW_CODE, classKey: SITE_ROW_CLASS, points: sitePoints }, { ...requirement, assetClass: [] }, params);
  });
  return { assetId: SITE_ROW_ID, code: SITE_ROW_CODE, classKey: SITE_ROW_CLASS, cells };
}

function assetCell(asset: PipelineAsset, assets: readonly PipelineAsset[], points: readonly SitePointStat[], requirement: DetectorRequirement, params: ReadinessParams): ReadinessCell {
  const targeting = targetingOf(requirement.detectorId);
  const hasOwn = points.some((p) => p.assetId === asset.id);
  if (targeting === null || targeting.findingUnit === 'site') return naCell(asset.id, asset.code, asset.classKey, requirement);
  if (targeting.targetClass === null) {
    if (!hasOwn) return naCell(asset.id, asset.code, asset.classKey, requirement);
    return readinessCell({ id: asset.id, code: asset.code, classKey: asset.classKey, points: points.filter((p) => p.assetId === asset.id).map(toReadinessPoint) }, { ...requirement, assetClass: [] }, params);
  }
  if (targeting.targetClass !== asset.classKey) return naCell(asset.id, asset.code, asset.classKey, requirement);
  return readinessCell({ id: asset.id, code: asset.code, classKey: asset.classKey, points: relatedPoints(asset, assets, points).map(toReadinessPoint) }, { ...requirement, assetClass: [] }, params);
}

/** 사이트 행(맨 앞) + 설비 경로순 행. 설비 행은 자기 포인트가 있거나 설비 단위 탐지기의 대상 종류인 설비만 */
export function siteReadinessRows(
  assets: readonly PipelineAsset[],
  points: readonly SitePointStat[],
  requirements: readonly DetectorRequirement[],
  overrides: Partial<ReadinessParams> = {},
): ReadinessRow[] {
  const params = { ...READINESS_DEFAULTS, ...overrides };
  if (!(params.minCompleteness >= 0 && params.minCompleteness <= 1)) throw new RangeError(`준비도: minCompleteness는 0~1이어야 합니다 (${params.minCompleteness})`);
  const targetClasses = new Set(requirements.map((r) => targetingOf(r.detectorId)?.targetClass).filter((c): c is string => typeof c === 'string'));
  const shown = [...assets].sort(byCode).filter((a) => points.some((p) => p.assetId === a.id) || targetClasses.has(a.classKey));
  return [
    siteRow(assets, points, requirements, params),
    ...shown.map((asset) => ({ assetId: asset.id, code: asset.code, classKey: asset.classKey, cells: requirements.map((requirement) => assetCell(asset, assets, points, requirement, params)) })),
  ];
}
