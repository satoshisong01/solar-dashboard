// 탐지기 실행 결과 → 평가 기록 (순수): finding 요약, 근거 창, 주입 크기, 상태 집계.
import type { Json, JsonObject } from '@/lib/analytics/types';
import type { DetectorOutcome } from '@/lib/analytics/pipeline/types';
import type { InjectionTruth } from '../truth';
import { EVAL_DETECTOR_IDS, type BinWindow, type DetectionRecord, type EvalDetectorId, type EvidenceWindows, type OutcomeTally } from './types';

export const isEvalDetector = (id: string): id is EvalDetectorId => (EVAL_DETECTOR_IDS as readonly string[]).includes(id);

const asObject = (value: Json | undefined): JsonObject | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null);
const asNumber = (value: Json | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** 근거 bin 표에서 결합에 쓴 bin의 기준·최근 기간과 가중치 */
function binWindows(bins: Json | undefined): BinWindow[] {
  if (!Array.isArray(bins)) return [];
  return bins.flatMap((raw: Json) => {
    const b = asObject(raw);
    const [referenceFrom, referenceTo, recentFrom, recentTo, weight] = [asNumber(b?.ref_from), asNumber(b?.ref_to), asNumber(b?.cur_from), asNumber(b?.cur_to), asNumber(b?.weight)];
    if (b?.used !== true || referenceFrom === null || referenceTo === null || recentFrom === null || recentTo === null || weight === null || !(weight > 0)) return [];
    return [{ referenceFrom, referenceTo, recentFrom, recentTo, weight }];
  });
}

/** ess.capacity_fade 근거의 기준·최근 창 (없으면 null) */
export function evidenceWindows(evidence: JsonObject): EvidenceWindows | null {
  const reference = asObject(evidence.reference);
  const recent = asObject(evidence.recent);
  const values = [asNumber(reference?.from), asNumber(reference?.to), asNumber(recent?.from), asNumber(recent?.to)];
  const [referenceFrom, referenceTo, recentFrom, recentTo] = values;
  if (referenceFrom == null || referenceTo == null || recentFrom == null || recentTo == null) return null;
  return { referenceFrom, referenceTo, recentFrom, recentTo, bins: binWindows(evidence.bins) };
}

/** 점검 시각 하나의 결과 → 설비 finding 기록 */
export function detectionOf(outcomes: readonly DetectorOutcome[], now: number): DetectionRecord[] {
  return outcomes.flatMap((outcome) =>
    outcome.findings.flatMap((f): DetectionRecord[] =>
      f.assetId === null
        ? []
        : [{ ts: now, detectorId: f.detectorId, assetId: f.assetId, failureMode: f.failureMode, severity: f.severity, confidence: f.confidence, effect: f.effect.value, ciLow: f.effect.ciLow, ciHigh: f.effect.ciHigh, windows: evidenceWindows(f.evidence) }],
    ),
  );
}

/** 스윕 크기와 단위 (주입 정답 파라미터에서) */
export function injectionMagnitude(injection: InjectionTruth): { magnitude: number; unit: string } {
  const p = injection.params;
  const num = (key: string): number => (typeof p[key] === 'number' ? (p[key] as number) : Number.NaN);
  switch (injection.kind) {
    case 'fault.battery_capacity_fade':
      return { magnitude: num('totalPct'), unit: '%' };
    case 'fault.inverter_efficiency_drop':
      return { magnitude: num('pctPoints'), unit: '%p' };
    case 'fault.elz_stack_degradation':
    case 'fault.fc_voltage_decay':
      return { magnitude: num('uvPerH'), unit: 'µV/h' };
    case 'fault.cell_imbalance':
      return { magnitude: num('mVPerMonth'), unit: 'mV/월' };
    case 'dq.stuck_sensor':
    case 'dq.sample_loss':
      return { magnitude: num('durationHours'), unit: 'h' };
    default:
      return { magnitude: Number.NaN, unit: '' };
  }
}

const REASON_PREFIX = 40;

export function tallyOutcomes(outcomes: readonly DetectorOutcome[]): OutcomeTally[] {
  return EVAL_DETECTOR_IDS.map((detectorId) => {
    const own = outcomes.filter((o) => o.detectorId === detectorId);
    const reasons = new Map<string, number>();
    for (const o of own) {
      if (o.reason === null) continue;
      const key = o.reason.replace(/[\d.]+/g, '#').slice(0, REASON_PREFIX);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    return {
      detectorId,
      ok: own.filter((o) => o.status === 'ok').length,
      insufficient: own.filter((o) => o.status === 'insufficient').length,
      error: own.filter((o) => o.status === 'error').length,
      topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  });
}
