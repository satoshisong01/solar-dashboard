// 주입 고장 정답 → 탐지 결과 대조 (순수): 첫 탐지(하루 단위로 좁힘)·마지막 탐지 효과·같은 창의 참 크기, 부수 탐지기 구간.
// 사이트 단위 탐지기(SITE_SCOPED_DETECTORS)는 설비 id 대신 SITE_ASSET_ID로 맞추고, 여러 설비에 걸친 주입(예: 전 인버터 오염)은 한 건으로 센다.
import type { DetectorOutcome } from '@/lib/analytics/pipeline/types';
import { MS_PER_DAY } from '@/lib/analytics/types';
import type { InjectionTruth } from '../truth';
import type { EvalSite } from './assets';
import { findingAssetId, injectionMagnitude, isEvalDetector } from './records';
import { EVAL_DETECTOR_CLASS, SITE_ASSET_ID, SITE_SCOPED_DETECTORS, type DetectionRecord, type EvalDetectorId, type EvidenceWindows, type InjectionResult, type RelatedWindow } from './types';

export interface InjectionContext {
  readonly site: EvalSite;
  readonly detections: readonly DetectionRecord[];
  /** 랙 경로 → 시간 평균 참 SOH */
  readonly soh: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  readonly outcomesAt: (now: number, detectorIds: readonly EvalDetectorId[], targetAssetIds?: ReadonlySet<number>) => DetectorOutcome[];
}

function firstDetection(ctx: InjectionContext, detectorId: EvalDetectorId, assetId: number, failureModes: readonly string[], range: { from: number; to: number }): number | null {
  const targets = assetId === SITE_ASSET_ID ? undefined : new Set([assetId]);
  for (let now = range.from; now <= range.to; now += MS_PER_DAY) {
    const outcomes = ctx.outcomesAt(now, [detectorId], targets);
    if (outcomes.some((o) => o.findings.some((f) => findingAssetId(f) === assetId && failureModes.includes(f.failureMode)))) return now;
  }
  return null;
}

function windowMean(points: readonly (readonly [number, number])[] | undefined, from: number, to: number): number | null {
  const inside = (points ?? []).filter(([ts]) => ts >= from && ts <= to);
  return inside.length === 0 ? null : inside.reduce((sum, [, v]) => sum + v, 0) / inside.length;
}

/** 참 SOH 비율 변화 [%]. bin별 기준이면 bin마다 (최근 기간 평균 ÷ 기준 기간 평균)을 결합 가중치로 합친다 (탐지기 추정과 같은 정의) */
function trueCapacityEffect(soh: readonly (readonly [number, number])[] | undefined, windows: EvidenceWindows): number | null {
  const ratio = (refFrom: number, refTo: number, curFrom: number, curTo: number): number | null => {
    const reference = windowMean(soh, refFrom, refTo);
    const recent = windowMean(soh, curFrom, curTo);
    return reference === null || recent === null || reference === 0 ? null : recent / reference;
  };
  if (windows.bins.length === 0) {
    const whole = ratio(windows.referenceFrom, windows.referenceTo, windows.recentFrom, windows.recentTo);
    return whole === null ? null : (whole - 1) * 100;
  }
  const parts = windows.bins.map((b) => ({ weight: b.weight, ratio: ratio(b.referenceFrom, b.referenceTo, b.recentFrom, b.recentTo) }));
  if (parts.some((p) => p.ratio === null)) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return (parts.reduce((sum, p) => sum + (p.weight / totalWeight) * (p.ratio as number), 0) - 1) * 100;
}

/** 크기가 목표에 다 도달하고 최근 비교 기간(30일)이 지난 뒤의 탐지만 참 크기와 비교하는 수준형 P3 고장 */
const LEVEL_FAULTS: ReadonlySet<string> = new Set(['fault.tank_leak', 'fault.elz_sec_rise', 'fault.compressor_valve_wear', 'fault.rack_resistance_growth', 'fault.fc_air_filter_clog']);
const SETTLED_MS = 30 * MS_PER_DAY;

function trueEffectOf(ctx: InjectionContext, injection: InjectionTruth, detectorId: EvalDetectorId, magnitude: number, last: DetectionRecord | undefined): number | null {
  if (detectorId === 'el.voltage_rise' || detectorId === 'fc.voltage_decay') return magnitude;
  if (detectorId === 'pv.inverter_peer') return -magnitude;
  if (detectorId === 'ess.capacity_fade') return last?.windows && injection.assetPath !== null ? trueCapacityEffect(ctx.soh[injection.assetPath], last.windows) : null;
  const fullEffectTs = Number(injection.params.fullEffectTs);
  const settled = last !== undefined && Number.isFinite(fullEffectTs) && last.ts >= fullEffectTs + SETTLED_MS;
  return LEVEL_FAULTS.has(injection.kind) && settled ? magnitude : null;
}

/** 사이트 단위 탐지기 주입은 (종류·시작·크기)마다 한 건 */
function dedupeSiteScoped(injections: readonly InjectionTruth[], detectorId: EvalDetectorId): InjectionTruth[] {
  if (!SITE_SCOPED_DETECTORS.has(detectorId)) return [...injections];
  return [...new Map(injections.map((i) => [`${i.kind}|${i.startTs}|${injectionMagnitude(i).magnitude}`, i])).values()];
}

function resultOf(ctx: InjectionContext, injection: InjectionTruth, detectorId: EvalDetectorId, assetId: number): InjectionResult {
  const { magnitude, unit } = injectionMagnitude(injection);
  const own = ctx.detections.filter((d) => d.detectorId === detectorId && d.assetId === assetId && injection.expectedFailureModes.includes(d.failureMode) && d.ts >= injection.startTs);
  const firstWeekly = own[0];
  const firstDetectionTs = firstWeekly ? firstDetection(ctx, detectorId, assetId, injection.expectedFailureModes, { from: Math.max(injection.startTs, firstWeekly.ts - 6 * MS_PER_DAY), to: firstWeekly.ts }) : null;
  const last = own.at(-1);
  return { injection, detectorId, assetId, magnitude, unit, firstDetectionTs, finalEffect: last?.effect ?? null, trueEffect: trueEffectOf(ctx, injection, detectorId, magnitude, last) };
}

/** 탐지기가 finding을 내는 설비: 주입 설비가 탐지기 대상 종류가 아니면 그 하위 설비 중 대상 종류 (예: 전해조 비에너지 주입 ELZ1 → 스택 ELZ1/STACK1) */
function detectorAssetOf(site: EvalSite, assetPath: string, detectorId: EvalDetectorId) {
  const asset = site.byPath.get(assetPath);
  const classKey = EVAL_DETECTOR_CLASS[detectorId];
  if (!asset || asset.classKey === classKey || classKey === '*') return asset;
  return [...site.byPath.entries()].find(([path, a]) => path.startsWith(`${assetPath}/`) && a.classKey === classKey)?.[1] ?? asset;
}

export function injectionResults(ctx: InjectionContext, injections: readonly InjectionTruth[]): InjectionResult[] {
  const pairs = injections.flatMap((injection) => injection.expectedDetectors.filter(isEvalDetector).map((detectorId) => ({ injection, detectorId })));
  const detectorIds = [...new Set(pairs.map((p) => p.detectorId))];
  return detectorIds.flatMap((detectorId) =>
    dedupeSiteScoped(pairs.filter((p) => p.detectorId === detectorId).map((p) => p.injection), detectorId).flatMap((injection) => {
      if (SITE_SCOPED_DETECTORS.has(detectorId)) return [resultOf(ctx, injection, detectorId, SITE_ASSET_ID)];
      const asset = injection.assetPath === null ? undefined : detectorAssetOf(ctx.site, injection.assetPath, detectorId);
      return asset ? [resultOf(ctx, injection, detectorId, asset.id)] : [];
    }),
  );
}

/** 정답의 부수 탐지기 → 주입 설비와 하위 설비 id 구간 (사이트 단위 탐지기는 SITE_ASSET_ID) */
export function relatedWindowsOf(site: EvalSite, injections: readonly InjectionTruth[]): RelatedWindow[] {
  return injections.flatMap((injection) => {
    const path = injection.assetPath;
    const detectors = injection.relatedDetectors ?? [];
    if (path === null || detectors.length === 0) return [];
    const assetIds = [...site.byPath.entries()].filter(([p]) => p === path || p.startsWith(`${path}/`)).map(([, a]) => a.id);
    return detectors.map((detectorId) => ({ detectorId, assetIds: SITE_SCOPED_DETECTORS.has(detectorId) ? [SITE_ASSET_ID] : assetIds, startTs: injection.startTs, endTs: injection.endTs }));
  });
}
