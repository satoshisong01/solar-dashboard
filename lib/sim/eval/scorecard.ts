// CI 게이트(설계 §5.5)와 스코어카드 JSON (lib/analytics/scorecard.json). 탐지기 신뢰 배지·/sim 화면이 이 파일을 읽는다.
import { P2_DETECTORS } from '@/lib/analytics/detectors';
import { r } from '@/lib/analytics/detectors/common';
import type { EvalPreset } from '../presets';
import { capacityAvailability, socLimitControlScore } from './availability';
import { curveForSite, scoreAll, scoreAtLeast, type CurvePoint, type DetectorScore } from './score';
import { EVAL_DETECTOR_IDS, type SiteJobResult } from './types';

export const SCORECARD_VERSION = 1;

export interface GateResult {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly comparator: '>=' | '<=' | '<';
  readonly threshold: number;
  /** 평가할 주입이 없으면(value null) 실패로 본다 */
  readonly pass: boolean;
}

const compare = (value: number, comparator: GateResult['comparator'], threshold: number): boolean => (comparator === '>=' ? value >= threshold : comparator === '<=' ? value <= threshold : value < threshold);

const gate = (id: string, description: string, value: number | null, comparator: GateResult['comparator'], threshold: number): GateResult => ({
  id,
  description,
  value: value === null ? null : (r(value, 4) ?? null),
  comparator,
  threshold,
  pass: value !== null && compare(value, comparator, threshold),
});

/** 태양광+ESS(SIM-A)와 연계형(SIM-B) 용량 감소 게이트, 판정 가능 기간·SOC 상한 변경 대조군 게이트 */
function capacityGates(jobs: readonly SiteJobResult[]): GateResult[] {
  const solar = scoreAtLeast(jobs, 'ess.capacity_fade', 5, { siteCode: 'SIM-A' });
  const integrated = scoreAtLeast(jobs, 'ess.capacity_fade', 5, { siteCode: 'SIM-B' });
  const summer = Math.max(0, ...capacityAvailability(jobs).map((s) => s.summerLongestInsufficientDays));
  const control = socLimitControlScore(jobs);
  return [
    gate('ess.capacity_fade.recall_5pct', `ess.capacity_fade SIM-A(태양광+ESS) 5% 이상 재현율 (주입 ${solar.injections}건)`, solar.recall, '>=', 0.9),
    gate('ess.capacity_fade.mae_5pct', 'ess.capacity_fade SIM-A 5% 이상 크기 MAE [%p]', solar.magnitudeMae, '<=', 1),
    gate('ess.capacity_fade.delay_5pct', 'ess.capacity_fade SIM-A 5% 이상 탐지 지연 중앙값 [일]', solar.medianDelayDays, '<=', 21),
    gate('ess.capacity_fade.integrated_recall_5pct', `ess.capacity_fade SIM-B(연계형 부분 사이클) 5% 이상 재현율 (주입 ${integrated.injections}건)`, integrated.recall, '>=', 0.8),
    gate('ess.capacity_fade.integrated_delay_5pct', 'ess.capacity_fade SIM-B 5% 이상 탐지 지연 중앙값 [일]', integrated.medianDelayDays, '<=', 45),
    gate('ess.capacity_fade.summer_insufficient_run_days', 'ess.capacity_fade 여름(6~8월) 연속 판정 불능 최장 일수 (전 사이트·랙)', summer, '<', 60),
    gate('ess.capacity_fade.soc_limit_control_ok_checks', `ess.capacity_fade SOC 상한 변경 대조군 변경 7일 뒤 판정 ok 점검 수 (랙 ${control.racks}대 중 최소)`, control.minOkCheckpoints, '>=', 1),
    gate('ess.capacity_fade.soc_limit_control_fp', 'ess.capacity_fade SOC 상한 변경 대조군 변경 이후 finding 수', control.racks === 0 ? null : control.falsePositives, '<=', 0),
  ];
}

export function evaluateGates(jobs: readonly SiteJobResult[], scores: readonly DetectorScore[]): GateResult[] {
  const electrolyzer = scoreAtLeast(jobs, 'el.voltage_rise', 20);
  const fuelCell = scoreAtLeast(jobs, 'fc.voltage_decay', 20);
  const cell = scoreAtLeast(jobs, 'ess.cell_imbalance', 10);
  return [
    ...capacityGates(jobs),
    ...scores.map((s) => gate(`${s.detectorId}.fp_per_asset_month`, `${s.detectorId} 오탐 [건/자산·월] (대조군 포함, ${r(s.assetMonths, 1)} 자산·월)`, s.fpPerAssetMonth, '<=', 0.1)),
    gate('el.voltage_rise.recall_20uvh', `el.voltage_rise 20 µV/h 이상 재현율 (주입 ${electrolyzer.injections}건)`, electrolyzer.recall, '>=', 0.9),
    gate('el.voltage_rise.rel_error_20uvh', 'el.voltage_rise 20 µV/h 이상 크기 상대오차 중앙값', electrolyzer.magnitudeRelErrorMedian, '<=', 0.1),
    gate('fc.voltage_decay.rel_error_20uvh', `fc.voltage_decay 20 µV/h 이상 크기 상대오차 중앙값 (주입 ${fuelCell.injections}건)`, fuelCell.magnitudeRelErrorMedian, '<=', 0.1),
    gate('ess.cell_imbalance.recall_10mv', `ess.cell_imbalance 월 10 mV 이상 재현율 (주입 ${cell.injections}건)`, cell.recall, '>=', 0.9),
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

const roundCurve = (curve: readonly CurvePoint[]) =>
  curve.map((p) => ({ magnitude: p.magnitude, injections: p.injections, detected: p.detected, recall: r(p.recall, 3), median_delay_days: r(p.medianDelayDays, 1), magnitude_mae: r(p.magnitudeMae, 3) }));

function capacityExtras(jobs: readonly SiteJobResult[]) {
  const control = socLimitControlScore(jobs);
  return {
    curve_by_site: Object.fromEntries(['SIM-A', 'SIM-B'].map((site) => [site, roundCurve(curveForSite(jobs, 'ess.capacity_fade', site))])),
    availability: capacityAvailability(jobs).map((s) => ({
      site: s.siteCode,
      checkpoints: s.checkpoints,
      insufficient: s.insufficient,
      insufficient_ratio: r(s.insufficientRatio, 4),
      summer_insufficient_ratio: r(s.summerInsufficientRatio, 4),
      summer_longest_insufficient_days: r(s.summerLongestInsufficientDays, 1),
    })),
    soc_limit_control: { racks: control.racks, min_ok_checkpoints: control.minOkCheckpoints, false_positives: control.falsePositives, asset_months: r(control.assetMonths, 1) },
  };
}

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
            curve: roundCurve(s.curve),
            ...(id === 'ess.capacity_fade' ? capacityExtras(jobs) : {}),
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
