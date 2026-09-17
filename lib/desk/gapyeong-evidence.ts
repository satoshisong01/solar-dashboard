// 가평 구성 탐지기 3종 근거 스냅샷(finding_evidence.snapshot jsonb) → 표시 모델 (zod, 순수).
// 세 탐지기 모두 '기준 구간 값 → 최근 구간 값 + 한계선'이라는 같은 뼈대라 한 타입으로 읽는다.
// 모든 필드에 catch를 둬 옛 스냅샷·손상 스냅샷에서도 던지지 않는다 (p3-evidence.ts와 같은 규칙).
import * as z from 'zod';
import { parseChecks } from './evidence-checks';
import type { GapyeongEvidence, GapyeongEvidenceDetectorId } from './p3-evidence-types';
import { asRecord } from './json-read';
import { count, listOf, num, str } from './zod-read';

const PRV = z.object({
  threshold: z.object({ warn_bar_per_h: num, alert_bar_per_h: num, min_alarm_holds: count, alarm_holds: count }).catch({ warn_bar_per_h: null, alert_bar_per_h: null, min_alarm_holds: 0, alarm_holds: 0 }),
  leak_nl_per_min: num,
  downstream_volume_m3: num,
  setpoint_bar: num,
  reference: z.object({ holds: count, median_bar_per_h: num }).catch({ holds: 0, median_bar_per_h: null }),
  recent: z.object({ holds: count, median_bar_per_h: num, ci_low: num, ci_high: num }).catch({ holds: 0, median_bar_per_h: null, ci_low: null, ci_high: null }),
  holds: listOf(z.object({ date: z.string(), start: num, hours: count, creep_bar_per_h: num, start_bar: num, end_bar: num, settle_ratio: num })),
});

const HX = z.object({
  bin: z.object({ width: num, bins: listOf(z.number()) }).catch({ width: null, bins: [] }),
  gate: z.object({ min_delta_theta_k: num }).catch({ min_delta_theta_k: null }),
  design: z.object({ approach_k: num, ua_kw_k: num }).catch({ approach_k: null, ua_kw_k: null }),
  approach: z.object({ reference_k: num, recent_k: num, rise_k: num, ci_low_k: num, ci_high_k: num }).catch({ reference_k: null, recent_k: null, rise_k: null, ci_low_k: null, ci_high_k: null }),
  ua: z.object({ reference_kw_k: num, recent_kw_k: num, drop_pct: num }).nullable().catch(null),
  points: listOf(z.object({ date: z.string(), hot_in_c: num, approach_k: num, ua_kw_k: num })),
});

const O2 = z.object({
  limit: z.object({ compression_stop_pct: num, lel_pct: num }).catch({ compression_stop_pct: null, lel_pct: null }),
  reference: z.object({ days: count, median_pct: num }).catch({ days: 0, median_pct: null }),
  recent: z.object({ days: count, median_pct: num, p95_pct: num, margin_pct_points: num, ci_low: num, ci_high: num }).catch({ days: 0, median_pct: null, p95_pct: null, margin_pct_points: null, ci_low: null, ci_high: null }),
  days: listOf(z.object({ date: z.string(), median_pct: num, max_pct: num, hours: count, load: num })),
});

/** bar/h -> mbar/h (근거는 bar, 화면은 mbar로 읽는다) */
const mbar = (barPerH: number | null): number | null => (barPerH === null ? null : barPerH * 1000);

/**
 * 구간이 자기 대표값을 품는가. 접근온도 CI를 bin 가중 평균이 아니라 전체 단순 중앙값으로 내던 시절의
 * 스냅샷은 대표값 밖 구간을 담고 있다 — 다시 분석하기 전까지는 그 구간을 화면에 쓰지 않는다.
 */
const bracket = (level: number | null, low: number | null, high: number | null): boolean => level !== null && low !== null && high !== null && low <= level && level <= high;

const noteOf = (snapshot: unknown): string | null => str.parse(asRecord(snapshot).note);

function parsePrv(snapshot: unknown): GapyeongEvidence {
  const s = PRV.parse(asRecord(snapshot));
  return {
    kind: 'gapyeong',
    detectorId: 'prv.seat_leak',
    subject: '무유동 구간 하류 압력 상승률',
    unit: 'mbar/h',
    referenceCount: s.reference.holds,
    recentCount: s.recent.holds,
    referenceLevel: mbar(s.reference.median_bar_per_h),
    recentLevel: mbar(s.recent.median_bar_per_h),
    limit: mbar(s.threshold.warn_bar_per_h),
    limitLabel: '경고 기준',
    margin: s.threshold.warn_bar_per_h === null || s.recent.median_bar_per_h === null ? null : (s.threshold.warn_bar_per_h - s.recent.median_bar_per_h) * 1000,
    extra: { alarmHolds: s.threshold.alarm_holds, minAlarmHolds: s.threshold.min_alarm_holds, leakNlPerMin: s.leak_nl_per_min, downstreamVolumeM3: s.downstream_volume_m3, uaDropPct: null, marginPctPoints: null },
    points: s.holds.map((h) => ({ date: h.date, value: mbar(h.creep_bar_per_h) })),
    detail: {
      kind: 'prv',
      setpointBar: s.setpoint_bar,
      warnMbarPerH: mbar(s.threshold.warn_bar_per_h),
      alertMbarPerH: mbar(s.threshold.alert_bar_per_h),
      alarmHolds: s.threshold.alarm_holds,
      minAlarmHolds: s.threshold.min_alarm_holds,
      ciLowMbarPerH: mbar(s.recent.ci_low),
      ciHighMbarPerH: mbar(s.recent.ci_high),
      holds: s.holds.map((h) => ({ start: h.start, date: h.date, hours: h.hours, creepMbarPerH: mbar(h.creep_bar_per_h), startBar: h.start_bar, endBar: h.end_bar, settleRatio: h.settle_ratio })),
    },
    note: noteOf(snapshot),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

function parseHx(snapshot: unknown): GapyeongEvidence {
  const s = HX.parse(asRecord(snapshot));
  const ci = bracket(s.approach.recent_k, s.approach.ci_low_k, s.approach.ci_high_k) ? s.approach : { ci_low_k: null, ci_high_k: null };
  return {
    kind: 'gapyeong',
    detectorId: 'hx.fouling',
    subject: '접근온도 (1차측 입구 − 2차측 출구)',
    unit: 'K',
    referenceCount: s.points.length,
    recentCount: s.points.length,
    referenceLevel: s.approach.reference_k,
    recentLevel: s.approach.recent_k,
    limit: null,
    limitLabel: null,
    margin: null,
    extra: { alarmHolds: null, minAlarmHolds: null, leakNlPerMin: null, downstreamVolumeM3: null, uaDropPct: s.ua?.drop_pct ?? null, marginPctPoints: null },
    points: s.points.map((p) => ({ date: p.date, value: p.approach_k })),
    detail: {
      kind: 'hx',
      binWidthC: s.bin.width,
      bins: s.bin.bins,
      minDeltaThetaK: s.gate.min_delta_theta_k,
      designApproachK: s.design.approach_k,
      designUaKwK: s.design.ua_kw_k,
      riseK: s.approach.rise_k,
      ciLowK: ci.ci_low_k,
      ciHighK: ci.ci_high_k,
      uaReferenceKwK: s.ua?.reference_kw_k ?? null,
      uaRecentKwK: s.ua?.recent_kw_k ?? null,
      points: s.points.map((p) => ({ date: p.date, hotInC: p.hot_in_c, approachK: p.approach_k, uaKwK: p.ua_kw_k })),
    },
    note: noteOf(snapshot),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

function parseO2(snapshot: unknown): GapyeongEvidence {
  const s = O2.parse(asRecord(snapshot));
  return {
    kind: 'gapyeong',
    detectorId: 'o2.purity_drift',
    subject: '산소 중 수소 농도',
    unit: 'vol%',
    referenceCount: s.reference.days,
    recentCount: s.recent.days,
    referenceLevel: s.reference.median_pct,
    recentLevel: s.recent.median_pct,
    limit: s.limit.compression_stop_pct,
    limitLabel: '압축금지 한계',
    margin: s.recent.margin_pct_points,
    extra: { alarmHolds: null, minAlarmHolds: null, leakNlPerMin: null, downstreamVolumeM3: null, uaDropPct: null, marginPctPoints: s.recent.margin_pct_points },
    points: s.days.map((d) => ({ date: d.date, value: d.median_pct })),
    detail: {
      kind: 'o2',
      lelPct: s.limit.lel_pct,
      recentP95Pct: s.recent.p95_pct,
      ciLowPct: s.recent.ci_low,
      ciHighPct: s.recent.ci_high,
      days: s.days.map((d) => ({ date: d.date, medianPct: d.median_pct, maxPct: d.max_pct, hours: d.hours, load: d.load })),
    },
    note: noteOf(snapshot),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

const PARSERS: Readonly<Record<GapyeongEvidenceDetectorId, (snapshot: unknown) => GapyeongEvidence>> = {
  'prv.seat_leak': parsePrv,
  'hx.fouling': parseHx,
  'o2.purity_drift': parseO2,
};

export const GAPYEONG_EVIDENCE_METHODS: Readonly<Record<string, GapyeongEvidenceDetectorId>> = {
  hold_theil_sen_median: 'prv.seat_leak',
  approach_bin_shift: 'hx.fouling',
  daily_median_shift_with_legal_limit: 'o2.purity_drift',
};

export const isGapyeongEvidenceDetector = (id: string): id is GapyeongEvidenceDetectorId => Object.hasOwn(PARSERS, id);

export const parseGapyeongEvidence = (snapshot: unknown, detectorId: GapyeongEvidenceDetectorId): GapyeongEvidence => PARSERS[detectorId](snapshot);
