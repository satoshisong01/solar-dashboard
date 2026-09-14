// CI 게이트(설계 §5.5)와 스코어카드 JSON (lib/analytics/scorecard.json). 탐지기 신뢰 배지·/sim 화면이 이 파일을 읽는다.
import { P2_DETECTORS } from '@/lib/analytics/detectors';
import { r } from '@/lib/analytics/detectors/common';
import type { EvalPreset } from '../presets';
import { scoreAll, scoreAtLeast, type DetectorScore } from './score';
import { EVAL_DETECTOR_IDS, type SiteJobResult } from './types';

export const SCORECARD_VERSION = 1;

export interface GateResult {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly comparator: '>=' | '<=';
  readonly threshold: number;
  /** 평가할 주입이 없으면(value null) 실패로 본다 */
  readonly pass: boolean;
}

const gate = (id: string, description: string, value: number | null, comparator: GateResult['comparator'], threshold: number): GateResult => ({
  id,
  description,
  value: value === null ? null : (r(value, 4) ?? null),
  comparator,
  threshold,
  pass: value !== null && (comparator === '>=' ? value >= threshold : value <= threshold),
});

export function evaluateGates(jobs: readonly SiteJobResult[], scores: readonly DetectorScore[]): GateResult[] {
  const capacity = scoreAtLeast(jobs, 'ess.capacity_fade', 5);
  const electrolyzer = scoreAtLeast(jobs, 'el.voltage_rise', 20);
  return [
    gate('ess.capacity_fade.recall_5pct', `ess.capacity_fade 5% 이상 재현율 (주입 ${capacity.injections}건)`, capacity.recall, '>=', 0.9),
    gate('ess.capacity_fade.mae_5pct', 'ess.capacity_fade 5% 이상 크기 MAE [%p]', capacity.magnitudeMae, '<=', 1),
    gate('ess.capacity_fade.delay_5pct', 'ess.capacity_fade 5% 이상 탐지 지연 중앙값 [일]', capacity.medianDelayDays, '<=', 21),
    ...scores.map((s) => gate(`${s.detectorId}.fp_per_asset_month`, `${s.detectorId} 오탐 [건/자산·월] (대조군 포함, ${r(s.assetMonths, 1)} 자산·월)`, s.fpPerAssetMonth, '<=', 0.1)),
    gate('el.voltage_rise.recall_20uvh', `el.voltage_rise 20 µV/h 이상 재현율 (주입 ${electrolyzer.injections}건)`, electrolyzer.recall, '>=', 0.9),
  ];
}

export interface ScorecardOptions {
  readonly preset: EvalPreset;
  readonly seeds: readonly number[];
  readonly runs: readonly number[] | null;
  readonly generatedAt: string;
  readonly elapsedMs: number;
  readonly paramsNote: Readonly<Record<string, string>>;
}

const roundCurve = (s: DetectorScore) =>
  s.curve.map((p) => ({ magnitude: p.magnitude, injections: p.injections, detected: p.detected, recall: r(p.recall, 3), median_delay_days: r(p.medianDelayDays, 1), magnitude_mae: r(p.magnitudeMae, 3) }));

export function buildScorecard(jobs: readonly SiteJobResult[], options: ScorecardOptions) {
  const scores = scoreAll(jobs);
  const gates = evaluateGates(jobs, scores);
  const versions = Object.fromEntries(P2_DETECTORS.map((d) => [d.id, `${d.id}@${d.version}`]));
  return {
    version: SCORECARD_VERSION,
    generated_at: options.generatedAt,
    mode: 'memory',
    preset: { from: options.preset.from, days: options.preset.days, fault_start_day: options.preset.faultStartDay, capacity_fade_days: options.preset.capacityFadeDays, seeds: options.seeds, runs: options.runs, sweeps: options.preset.sweeps },
    jobs: jobs.length,
    elapsed_s: r(options.elapsedMs / 1000, 1),
    not_evaluated: { 'dq.gap_flatline': '메모리 모드는 전송 계층(단절·지연·시계 오차)을 재현하지 않아 DB E2E 모드에서만 평가합니다' },
    detectors: Object.fromEntries(
      EVAL_DETECTOR_IDS.map((id) => {
        const s = scores.find((score) => score.detectorId === id) as DetectorScore;
        return [
          id,
          {
            detector: versions[id],
            unit: s.unit,
            tp: s.tp,
            fp: s.fp,
            fn: s.fn,
            recall: r(s.recall, 3),
            precision: r(s.precision, 3),
            asset_months: r(s.assetMonths, 1),
            fp_per_asset_month: r(s.fpPerAssetMonth, 4),
            median_delay_days: r(s.medianDelayDays, 1),
            magnitude_mae: r(s.magnitudeMae, 3),
            min_detectable_magnitude: s.minDetectableMagnitude,
            curve: roundCurve(s),
            params_note: options.paramsNote[id] ?? null,
          },
        ];
      }),
    ),
    gates,
    pass: gates.every((g) => g.pass),
  };
}

export type Scorecard = ReturnType<typeof buildScorecard>;
