// 사이트 잡 결과 → 탐지기별 스코어카드 (순수): 재현율·정밀도·자산월당 오탐·탐지 지연·크기 오차·최소 탐지 크기 곡선.
// 판정 규칙
//   TP  = 주입 설비에서 기대 고장모드 finding이 주입 시작 ~ 종료 + toleranceDays 사이에 한 번이라도 나옴
//   FP  = 점검 시각의 finding 중 TP 조건이 아니고 주입 고장의 부수 탐지기 구간(related)도 아닌 것. 연속 점검에서 이어지면 한 건(열린 finding 하나)으로 센다
//   자산월 = 적용 설비 수 × (마지막 점검 − 첫 점검) / 30.44일
//   지연 = 첫 탐지(하루 단위) − 주입 시작, 크기 오차 = |마지막 탐지 효과 − 같은 창의 참 효과|
import { median } from '@/lib/analytics/stats/robust';
import { DAYS_PER_MONTH, MS_PER_DAY } from '@/lib/analytics/types';
import { EVAL_DETECTOR_IDS, type DetectionRecord, type EvalDetectorId, type InjectionResult, type SiteJobResult } from './types';

export const DEFAULT_TOLERANCE_DAYS = 7;

export interface CurvePoint {
  readonly magnitude: number;
  readonly injections: number;
  readonly detected: number;
  readonly recall: number;
  readonly medianDelayDays: number | null;
  readonly magnitudeMae: number | null;
}

export interface DetectorScore {
  readonly detectorId: EvalDetectorId;
  readonly unit: string | null;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly recall: number | null;
  readonly precision: number | null;
  readonly assetMonths: number;
  readonly fpPerAssetMonth: number;
  readonly medianDelayDays: number | null;
  readonly magnitudeMae: number | null;
  /** 재현율 0.9 이상인 가장 작은 크기 (없으면 null) */
  readonly minDetectableMagnitude: number | null;
  readonly curve: readonly CurvePoint[];
  readonly falsePositives: readonly { readonly jobId: string; readonly assetId: number; readonly firstTs: number; readonly checkpoints: number }[];
}

const isHit = (injection: InjectionResult, toleranceDays: number): boolean =>
  injection.firstDetectionTs !== null && injection.firstDetectionTs >= injection.injection.startTs && injection.firstDetectionTs <= (injection.injection.endTs ?? injection.injection.startTs) + toleranceDays * MS_PER_DAY;

const delayDays = (injection: InjectionResult): number | null => (injection.firstDetectionTs === null ? null : (injection.firstDetectionTs - injection.injection.startTs) / MS_PER_DAY);
const absError = (injection: InjectionResult): number | null => (injection.finalEffect === null || injection.trueEffect === null ? null : Math.abs(injection.finalEffect - injection.trueEffect));
const medianOrNull = (values: readonly (number | null)[]): number | null => {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return finite.length === 0 ? null : median(finite);
};
const meanOrNull = (values: readonly (number | null)[]): number | null => {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return finite.length === 0 ? null : finite.reduce((sum, v) => sum + v, 0) / finite.length;
};

/** 이 finding이 주입 고장을 맞힌 것인지 */
function explainedBy(detection: DetectionRecord, injections: readonly InjectionResult[], toleranceDays: number): boolean {
  return injections.some(
    (i) =>
      i.detectorId === detection.detectorId &&
      i.assetId === detection.assetId &&
      i.injection.expectedFailureModes.includes(detection.failureMode) &&
      detection.ts >= i.injection.startTs &&
      detection.ts <= (i.injection.endTs ?? i.injection.startTs) + toleranceDays * MS_PER_DAY,
  );
}

/** 다른 탐지기 대상 주입 고장이 함께 일으킨 finding인지 (예: 냉각팬 고장 인버터의 동종 비교 저성능) */
const relatedTo = (detection: DetectionRecord, job: SiteJobResult, toleranceDays: number): boolean =>
  job.related.some((r) => r.detectorId === detection.detectorId && r.assetIds.includes(detection.assetId) && detection.ts >= r.startTs && detection.ts <= (r.endTs ?? r.startTs) + toleranceDays * MS_PER_DAY);

/** 잡 하나의 오탐: 설비별로 연속 점검에서 이어진 거짓 finding을 한 건으로 묶는다 */
function falsePositivesOf(job: SiteJobResult, detectorId: EvalDetectorId, toleranceDays: number): DetectorScore['falsePositives'] {
  const own = job.injections.filter((i) => i.detectorId === detectorId);
  const falseByAsset = new Map<number, Set<number>>();
  for (const d of job.detections) {
    if (d.detectorId !== detectorId || explainedBy(d, own, toleranceDays) || relatedTo(d, job, toleranceDays)) continue;
    falseByAsset.set(d.assetId, new Set([...(falseByAsset.get(d.assetId) ?? []), d.ts]));
  }
  return [...falseByAsset.entries()].flatMap(([assetId, times]) => {
    const flags = job.checkpointTs.map((ts) => times.has(ts));
    return job.checkpointTs.flatMap((ts, i) => {
      if (!flags[i] || flags[i - 1]) return [];
      const length = flags.slice(i).findIndex((flag) => !flag);
      return [{ jobId: job.jobId, assetId, firstTs: ts, checkpoints: length === -1 ? flags.length - i : length }];
    });
  });
}

function curveOf(injections: readonly InjectionResult[], toleranceDays: number): CurvePoint[] {
  const magnitudes = [...new Set(injections.map((i) => i.magnitude))].sort((a, b) => a - b);
  return magnitudes.map((magnitude) => {
    const group = injections.filter((i) => i.magnitude === magnitude);
    const hits = group.filter((i) => isHit(i, toleranceDays));
    return { magnitude, injections: group.length, detected: hits.length, recall: hits.length / group.length, medianDelayDays: medianOrNull(hits.map(delayDays)), magnitudeMae: meanOrNull(hits.map(absError)) };
  });
}

function assetMonthsOf(job: SiteJobResult, detectorId: EvalDetectorId): number {
  const first = job.checkpointTs[0];
  const last = job.checkpointTs.at(-1);
  if (first === undefined || last === undefined) return 0;
  return ((job.applicableAssets[detectorId] ?? 0) * (last - first)) / MS_PER_DAY / DAYS_PER_MONTH;
}

export function scoreDetector(jobs: readonly SiteJobResult[], detectorId: EvalDetectorId, toleranceDays = DEFAULT_TOLERANCE_DAYS): DetectorScore {
  const injections = jobs.flatMap((job) => job.injections.filter((i) => i.detectorId === detectorId));
  const hits = injections.filter((i) => isHit(i, toleranceDays));
  const falsePositives = jobs.flatMap((job) => falsePositivesOf(job, detectorId, toleranceDays));
  const assetMonths = jobs.reduce((sum, job) => sum + assetMonthsOf(job, detectorId), 0);
  const curve = curveOf(injections, toleranceDays);
  const tp = hits.length;
  const fp = falsePositives.length;
  return {
    detectorId,
    unit: injections[0]?.unit ?? null,
    tp,
    fp,
    fn: injections.length - tp,
    recall: injections.length === 0 ? null : tp / injections.length,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    assetMonths,
    fpPerAssetMonth: assetMonths > 0 ? fp / assetMonths : 0,
    medianDelayDays: medianOrNull(hits.map(delayDays)),
    magnitudeMae: meanOrNull(hits.map(absError)),
    minDetectableMagnitude: curve.find((point) => point.recall >= 0.9)?.magnitude ?? null,
    curve,
    falsePositives,
  };
}

export interface PartialScoreOptions {
  readonly toleranceDays?: number;
  /** 이 사이트 주입만 (예: 태양광+ESS SIM-A · 연계형 SIM-B) */
  readonly siteCode?: string;
  /** 추가 조건 (예: 주입 종류가 섞인 탐지기에서 한 종류만) */
  readonly filter?: (injection: InjectionResult) => boolean;
}

/** 크기 오차 ÷ |참 크기| (참 크기가 0이거나 없으면 null) */
const relativeError = (injection: InjectionResult): number | null => {
  const error = absError(injection);
  return error === null || injection.trueEffect === null || injection.trueEffect === 0 ? null : error / Math.abs(injection.trueEffect);
};

/** 크기 이상 주입만 모은 부분 점수 (게이트용) */
export function scoreAtLeast(
  jobs: readonly SiteJobResult[],
  detectorId: EvalDetectorId,
  minMagnitude: number,
  options: PartialScoreOptions = {},
): Pick<DetectorScore, 'recall' | 'medianDelayDays' | 'magnitudeMae'> & { readonly injections: number; readonly magnitudeRelErrorMedian: number | null } {
  const toleranceDays = options.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  const injections = jobs.flatMap((job) =>
    job.injections.filter((i) => i.detectorId === detectorId && i.magnitude >= minMagnitude && (options.siteCode === undefined || i.injection.siteCode === options.siteCode) && (options.filter?.(i) ?? true)),
  );
  const hits = injections.filter((i) => isHit(i, toleranceDays));
  return {
    injections: injections.length,
    recall: injections.length === 0 ? null : hits.length / injections.length,
    medianDelayDays: medianOrNull(hits.map(delayDays)),
    magnitudeMae: meanOrNull(hits.map(absError)),
    magnitudeRelErrorMedian: medianOrNull(hits.map(relativeError)),
  };
}

/** 사이트 한 곳 주입만의 크기별 곡선 (용량 감소처럼 사이트 운전 방식마다 성능이 다른 탐지기) */
export function curveForSite(jobs: readonly SiteJobResult[], detectorId: EvalDetectorId, siteCode: string, toleranceDays = DEFAULT_TOLERANCE_DAYS): CurvePoint[] {
  return curveOf(jobs.flatMap((job) => job.injections.filter((i) => i.detectorId === detectorId && i.injection.siteCode === siteCode)), toleranceDays);
}

export const scoreAll = (jobs: readonly SiteJobResult[], toleranceDays = DEFAULT_TOLERANCE_DAYS): DetectorScore[] => EVAL_DETECTOR_IDS.map((id) => scoreDetector(jobs, id, toleranceDays));
