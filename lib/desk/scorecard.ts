// 시뮬레이터 스코어카드(lib/analytics/scorecard.json, npm run sim:eval이 갱신) 읽기와 탐지기 신뢰 배지. 순수 모듈.
import { asArray, asBoolean, asNumber, asRecord, asString } from './json-read';

export interface CurvePointView {
  readonly magnitude: number;
  readonly injections: number;
  readonly detected: number;
  readonly recall: number | null;
  readonly medianDelayDays: number | null;
  readonly magnitudeMae: number | null;
}

export interface DetectorScoreView {
  readonly detectorId: string;
  readonly detector: string;
  readonly unit: string | null;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly recall: number | null;
  readonly precision: number | null;
  readonly assetMonths: number | null;
  readonly fpPerAssetMonth: number | null;
  readonly medianDelayDays: number | null;
  readonly magnitudeMae: number | null;
  readonly minDetectableMagnitude: number | null;
  readonly curve: readonly CurvePointView[];
  readonly paramsNote: string | null;
}

export interface GateView {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly comparator: string;
  readonly threshold: number | null;
  readonly pass: boolean;
}

export interface ScorecardView {
  readonly generatedAt: string | null;
  readonly mode: string | null;
  readonly days: number | null;
  readonly seeds: readonly number[];
  readonly jobs: number | null;
  readonly detectors: readonly DetectorScoreView[];
  readonly gates: readonly GateView[];
  readonly pass: boolean | null;
  readonly notEvaluated: readonly (readonly [detectorId: string, note: string])[];
}

const numbers = (value: unknown): number[] => asArray(value).flatMap((v) => (asNumber(v) === null ? [] : [asNumber(v) as number]));

function parseDetector(detectorId: string, raw: unknown): DetectorScoreView {
  const d = asRecord(raw);
  return {
    detectorId,
    detector: asString(d.detector) ?? detectorId,
    unit: asString(d.unit),
    tp: asNumber(d.tp) ?? 0,
    fp: asNumber(d.fp) ?? 0,
    fn: asNumber(d.fn) ?? 0,
    recall: asNumber(d.recall),
    precision: asNumber(d.precision),
    assetMonths: asNumber(d.asset_months),
    fpPerAssetMonth: asNumber(d.fp_per_asset_month),
    medianDelayDays: asNumber(d.median_delay_days),
    magnitudeMae: asNumber(d.magnitude_mae),
    minDetectableMagnitude: asNumber(d.min_detectable_magnitude),
    curve: asArray(d.curve).flatMap((item) => {
      const p = asRecord(item);
      const magnitude = asNumber(p.magnitude);
      return magnitude === null
        ? []
        : [{ magnitude, injections: asNumber(p.injections) ?? 0, detected: asNumber(p.detected) ?? 0, recall: asNumber(p.recall), medianDelayDays: asNumber(p.median_delay_days), magnitudeMae: asNumber(p.magnitude_mae) }];
    }),
    paramsNote: asString(d.params_note),
  };
}

export function parseScorecard(raw: unknown): ScorecardView {
  const s = asRecord(raw);
  const preset = asRecord(s.preset);
  return {
    generatedAt: asString(s.generated_at),
    mode: asString(s.mode),
    days: asNumber(preset.days),
    seeds: numbers(preset.seeds),
    jobs: asNumber(s.jobs),
    detectors: Object.entries(asRecord(s.detectors)).map(([id, value]) => parseDetector(id, value)),
    gates: asArray(s.gates).flatMap((item) => {
      const g = asRecord(item);
      const id = asString(g.id);
      return id === null ? [] : [{ id, description: asString(g.description) ?? id, value: asNumber(g.value), comparator: asString(g.comparator) ?? '', threshold: asNumber(g.threshold), pass: asBoolean(g.pass) ?? false }];
    }),
    pass: asBoolean(s.pass),
    notEvaluated: Object.entries(asRecord(s.not_evaluated)).flatMap(([id, note]) => (typeof note === 'string' ? [[id, note] as const] : [])),
  };
}

/** '3%' · '2%p' · '10 µV/h' */
export function formatMagnitude(value: number | null, unit: string | null): string | null {
  if (value === null) return null;
  if (unit === null || unit === '') return String(value);
  return unit.startsWith('%') ? `${value}${unit}` : `${value} ${unit}`;
}

export type TrustBadge =
  | Readonly<{ kind: 'evaluated'; recall: number | null; minDetectable: string | null; fpPerAssetMonth: number | null; assetMonths: number | null; medianDelayDays: number | null; generatedAt: string | null }>
  | Readonly<{ kind: 'none'; note: string | null }>;

/** 탐지기 신뢰 배지. 스코어카드에 없거나(평가 안 함) 주입·오탐 표본이 모두 없으면 '평가 결과 없음' */
export function trustBadgeFor(scorecard: ScorecardView, detectorId: string): TrustBadge {
  const score = scorecard.detectors.find((d) => d.detectorId === detectorId);
  const note = scorecard.notEvaluated.find(([id]) => id === detectorId)?.[1] ?? null;
  if (!score || (score.recall === null && score.fpPerAssetMonth === null)) return { kind: 'none', note };
  return {
    kind: 'evaluated',
    recall: score.recall,
    minDetectable: formatMagnitude(score.minDetectableMagnitude, score.unit),
    fpPerAssetMonth: score.fpPerAssetMonth,
    assetMonths: score.assetMonths,
    medianDelayDays: score.medianDelayDays,
    generatedAt: scorecard.generatedAt,
  };
}
