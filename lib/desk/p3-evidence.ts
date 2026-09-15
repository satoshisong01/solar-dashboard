// P3 탐지기 근거 스냅샷(finding_evidence.snapshot jsonb) → 표시 모델 (zod, 순수).
// 모든 필드에 catch를 둬 옛 스냅샷(필드 없음)·손상 스냅샷(타입 틀림)에서도 던지지 않는다: 값은 null·0·빈 배열로, 형식이 깨진 배열 항목은 버린다.
// 탐지기 스냅샷 형식은 lib/analytics/detectors/{tank-static-leak-checks,h2chain-mass-balance,matched-rise,pv-soiling-rate,inv-thermal-samples}.ts의 evidence를 따른다.
import * as z from 'zod';
import { parseChecks } from './evidence-checks';
import type { MassBalanceEvidence, P3EvidenceView, SoilingEvidence, TankLeakEvidence, ThermalEvidence } from './p3-evidence-types';
import { parseRiseEvidence, riseDetectorOfMetric } from './p3-rise-evidence';
import { isRiseDetector } from './rise-meta';
import { asRecord } from './json-read';
import { bool, count, listOf, num, str } from './zod-read';

const datePi = z.object({ date: z.string(), pi: z.number() });
const lineOf = (points: readonly { date: string; pi: number }[]) => (points.length >= 2 ? points : null);

const TANK = z.object({
  eos: z.object({ model: str, volume_m3: num }).catch({ model: null, volume_m3: null }),
  combined: z.object({ leak_kg_per_day: num, ci_low: num, ci_high: num, pct_per_day: num }).catch({ leak_kg_per_day: null, ci_low: null, ci_high: null, pct_per_day: null }),
  significance: z.object({ noise_sigma_kg_per_day: num, z_sigma: num, threshold_kg_per_day: num }).catch({ noise_sigma_kg_per_day: null, z_sigma: null, threshold_kg_per_day: null }),
  baseline_bias: z.object({ kg_per_day: num }).catch({ kg_per_day: null }),
  safety: z.object({ category_safety: bool, safety_kg_per_day: num }).catch({ category_safety: false, safety_kg_per_day: null }),
  holds: listOf(z.object({ role: z.enum(['reference', 'recent']), start: z.number(), hours: num, loss_kg_per_day: num, ci_low: num, ci_high: num, t_mean_c: num, t_rate_c_per_day: num, p_mean_bar: num })),
  representative: z
    .object({ start: z.number(), end: z.number(), points: listOf(z.object({ ts: z.number(), p_bar: num, t_c: num, mass_kg: num })) })
    .nullable()
    .catch(null),
});

export function parseTankLeak(snapshot: unknown): TankLeakEvidence {
  const s = TANK.parse(asRecord(snapshot));
  return {
    kind: 'tank_leak',
    eosModel: s.eos.model,
    volumeM3: s.eos.volume_m3,
    leakKgPerDay: s.combined.leak_kg_per_day,
    ciLow: s.combined.ci_low,
    ciHigh: s.combined.ci_high,
    pctPerDay: s.combined.pct_per_day,
    noiseSigma: s.significance.noise_sigma_kg_per_day,
    zSigma: s.significance.z_sigma,
    thresholdKgPerDay: s.significance.threshold_kg_per_day,
    biasKgPerDay: s.baseline_bias.kg_per_day,
    safetyCategory: s.safety.category_safety,
    safetyKgPerDay: s.safety.safety_kg_per_day,
    holds: s.holds.map((h) => ({ role: h.role, start: h.start, hours: h.hours, lossKgPerDay: h.loss_kg_per_day, ciLow: h.ci_low, ciHigh: h.ci_high, tMeanC: h.t_mean_c, tRateCPerDay: h.t_rate_c_per_day, pMeanBar: h.p_mean_bar })),
    representative: s.representative && { start: s.representative.start, end: s.representative.end, points: s.representative.points.map((p) => ({ ts: p.ts, pBar: p.p_bar, tC: p.t_c, massKg: p.mass_kg })) },
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

const MASS_BALANCE = z.object({
  reference: z.object({ days: count, from: num, median_pct: num, sigma_pct: num }).catch({ days: 0, from: null, median_pct: null, sigma_pct: null }),
  recent: z.object({ days: count, from: num, median_pct: num, median_kg: num }).catch({ days: 0, from: null, median_pct: null, median_kg: null }),
  cusum: z
    .object({ direction: z.enum(['up', 'down']).nullable().catch(null), alarm_day: str, change_start_day: str, k: num, h: num, points: listOf(z.object({ date: z.string(), s: z.number() })) })
    .catch({ direction: null, alarm_day: null, change_start_day: null, k: null, h: null, points: [] }),
  days: listOf(z.object({ date: z.string(), produced: num, fc_consumed: num, stored_delta: num, vented_est: num, residual: num, residual_pct: num, completeness: num })),
});

export function parseMassBalance(snapshot: unknown): MassBalanceEvidence {
  const s = MASS_BALANCE.parse(asRecord(snapshot));
  const days = s.days.map((d) => ({ date: d.date, produced: d.produced, fcConsumed: d.fc_consumed, storedDelta: d.stored_delta, ventedEst: d.vented_est, residual: d.residual, residualPct: d.residual_pct, completeness: d.completeness }));
  return {
    kind: 'mass_balance',
    reference: { days: s.reference.days, from: s.reference.from, medianPct: s.reference.median_pct, sigmaPct: s.reference.sigma_pct },
    recent: { days: s.recent.days, from: s.recent.from, medianPct: s.recent.median_pct, medianKg: s.recent.median_kg },
    cusum: { direction: s.cusum.direction, alarmDay: s.cusum.alarm_day, changeStartDay: s.cusum.change_start_day, k: s.cusum.k, h: s.cusum.h, points: s.cusum.points },
    days,
    hasBalanceTerms: days.some((d) => d.fcConsumed !== null || d.storedDelta !== null),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

const SOILING = z.object({
  rate_pct_per_day: num,
  gamma_per_c: num,
  pi_points: listOf(datePi),
  current_line: listOf(datePi),
  segments: listOf(z.object({ from: z.string(), to: z.string(), clear_days: count, rate_pct_per_day: num, ci_low: num, ci_high: num, line: listOf(datePi) })),
  resets: listOf(z.object({ date: z.string(), kind: z.string(), recovery_pct: num })),
  economics: z.object({ cumulative_loss_kwh: num, daily_loss_kwh: num, loss_value_krw: num }).catch({ cumulative_loss_kwh: null, daily_loss_kwh: null, loss_value_krw: null }),
  smp_krw_per_kwh: num,
  cleaning_cost_krw: num,
  exclusions: z.record(z.string(), z.unknown()).catch({}),
});

export function parseSoiling(snapshot: unknown): SoilingEvidence {
  const s = SOILING.parse(asRecord(snapshot));
  return {
    kind: 'soiling',
    ratePctPerDay: s.rate_pct_per_day,
    gammaPerC: s.gamma_per_c,
    piPoints: s.pi_points,
    currentLine: lineOf(s.current_line),
    segments: s.segments.map((seg) => ({ from: seg.from, to: seg.to, clearDays: seg.clear_days, ratePctPerDay: seg.rate_pct_per_day, ciLow: seg.ci_low, ciHigh: seg.ci_high, line: lineOf(seg.line) })),
    resets: s.resets.map((reset) => ({ date: reset.date, kind: reset.kind, recoveryPct: reset.recovery_pct })),
    economics: { cumulativeLossKwh: s.economics.cumulative_loss_kwh, dailyLossKwh: s.economics.daily_loss_kwh, lossValueKrw: s.economics.loss_value_krw },
    smpKrwPerKwh: s.smp_krw_per_kwh,
    cleaningCostKrw: s.cleaning_cost_krw,
    exclusions: Object.entries(s.exclusions).flatMap(([code, value]) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? [[code, value] as const] : [])),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

const THERMAL = z.object({
  derate_start_c: num,
  margin_c: num,
  gap_pct: num,
  days: listOf(z.object({ date: z.string(), derate_h: num, loss_kwh: num, ambient_max_c: num })),
  ambient_bins: listOf(z.object({ ambient_bin_c: z.number(), n_ref: count, n_cur: count, ref_derate_h: num, cur_derate_h: num })),
  ambient_bin_shift_h: z.object({ ref: z.number(), cur: z.number() }).nullable().catch(null),
  representative_day: z
    .object({ date: z.string(), unit: z.string().catch('kW/kWp'), points: listOf(z.object({ ts: z.number(), own: num, peer: num, heatsink_c: num })) })
    .nullable()
    .catch(null),
});

export function parseThermal(snapshot: unknown): ThermalEvidence {
  const s = THERMAL.parse(asRecord(snapshot));
  return {
    kind: 'thermal',
    derateStartC: s.derate_start_c,
    marginC: s.margin_c,
    gapPct: s.gap_pct,
    days: s.days.map((d) => ({ date: d.date, derateH: d.derate_h, lossKwh: d.loss_kwh, ambientMaxC: d.ambient_max_c })),
    ambientBins: s.ambient_bins.map((b) => ({ binC: b.ambient_bin_c, nRef: b.n_ref, nCur: b.n_cur, refDerateH: b.ref_derate_h, curDerateH: b.cur_derate_h })),
    binShift: s.ambient_bin_shift_h,
    representativeDay: s.representative_day && { date: s.representative_day.date, unit: s.representative_day.unit, points: s.representative_day.points.map((p) => ({ ts: p.ts, own: p.own, peer: p.peer, heatsinkC: p.heatsink_c })) },
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

const METHOD_PARSERS: Readonly<Record<string, (snapshot: unknown) => P3EvidenceView>> = {
  static_hold_theil_sen_weighted_median: parseTankLeak,
  residual_median_cusum: parseMassBalance,
  clear_day_pi_theil_sen_segments: parseSoiling,
  peer_gap_heatsink_threshold: parseThermal,
};

const DETECTOR_METHODS: Readonly<Record<string, string>> = {
  'tank.static_leak': 'static_hold_theil_sen_weighted_median',
  'h2chain.mass_balance_gap': 'residual_median_cusum',
  'pv.soiling_rate': 'clear_day_pi_theil_sen_segments',
  'inv.thermal_derating': 'peer_gap_heatsink_threshold',
};

/** 'el.sec_rise@1' → 'el.sec_rise' (스냅샷 detector 필드는 분석 실행이 붙인다) */
export const detectorIdOf = (snapshot: unknown): string | null => {
  const value = asRecord(snapshot).detector;
  return typeof value === 'string' && value !== '' ? (value.split('@')[0] ?? null) : null;
};

/**
 * P3 근거면 표시 모델, 아니면 null. 탐지기 id(인자 → 스냅샷 detector 필드) 우선, 없으면 method로 고른다.
 * matched_ratio는 용량 감소와 같은 method라 metric으로 상승 탐지기를 가린다.
 */
export function parseP3Evidence(snapshot: unknown, detectorId?: string | null): P3EvidenceView | null {
  const s = asRecord(snapshot);
  const id = detectorId ?? detectorIdOf(snapshot);
  if (id !== null && isRiseDetector(id)) return parseRiseEvidence(s, id);
  const method = (id !== null ? DETECTOR_METHODS[id] : undefined) ?? (typeof s.method === 'string' ? s.method : '');
  const parser = METHOD_PARSERS[method];
  if (parser) return parser(s);
  const rise = method === 'matched_ratio' && (id === null || isRiseDetector(id)) ? riseDetectorOfMetric(s.metric) : null;
  return rise === null ? null : parseRiseEvidence(s, rise);
}
