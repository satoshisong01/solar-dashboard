// 같은 조건 상승 탐지기 4종(el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth) 근거 → 표시 모델 (zod, 순수).
// 스냅샷 공통 조각은 lib/analytics/detectors/matched-rise.ts riseEvidence, 탐지기별 bin 폭·메모 필드는 각 탐지기 buildFinding을 따른다.
// bin 폭이 없는 옛 스냅샷은 탐지기 기본값으로 채운다.
import * as z from 'zod';
import { COMP_SEC_RISE_DEFAULTS } from '@/lib/analytics/detectors/comp-sec-rise';
import { EL_SEC_RISE_DEFAULTS } from '@/lib/analytics/detectors/el-sec-rise';
import { ESS_RESISTANCE_DEFAULTS } from '@/lib/analytics/detectors/ess-resistance-growth';
import { FC_BLOWER_WEAR_DEFAULTS } from '@/lib/analytics/detectors/fc-blower-wear';
import { DAYS_PER_MONTH } from '@/lib/analytics/types';
import { formatNumber } from '@/lib/format';
import { formatSigned } from './effect';
import { parseChecks } from './evidence-checks';
import { asRecord } from './json-read';
import type { RiseDetectorId, RiseEvidence } from './p3-evidence-types';
import { RISE_META, riseBinLabel, type RiseBinWidths } from './rise-meta';
import type { TrendView } from './trend';
import { bool, count, listOf, num, str } from './zod-read';

const windowSchema = z.object({ n: count, from: num, to: num }).catch({ n: 0, from: null, to: null });
const xyPct = z.object({ x: z.number(), pct: z.number() });

const RISE = z.object({
  reference: windowSchema,
  recent: windowSchema,
  rise_pct: num,
  ci_low_pct: num,
  ci_high_pct: num,
  bins: listOf(z.object({ key: z.string(), n_ref: count, n_cur: count, med_ref: num, med_cur: num, ratio: num, used: bool, ref_from: num, ref_to: num, excluded: str })),
  trend: z
    .object({ axis: str, unit: str, slope: num, ci_low: num, ci_high: num, change_start: num, points: listOf(xyPct), line: listOf(xyPct) })
    .nullable()
    .catch(null),
  bin_by: str,
  bin_widths: z.record(z.string(), z.unknown()).catch({}),
  break_in_hours: num,
  suction_temp_proxy: str,
  affinity_exponent: num,
  period_s: num,
  soc_range_pct: listOf(z.number()),
  min_step_c: num,
});

type RiseSnapshot = z.output<typeof RISE>;

const width = (widths: Readonly<Record<string, unknown>>, key: string, fallback: number): number => {
  const value = widths[key];
  return typeof value === 'number' && value > 0 ? value : fallback;
};

function widthsOf(detectorId: RiseDetectorId, s: RiseSnapshot): RiseBinWidths {
  const w = s.bin_widths;
  switch (detectorId) {
    case 'el.sec_rise': {
      // 옛 스냅샷(bin_by 없음)은 bin 키 접두어로 운전 조건 기준을 가린다
      const byCurrent = s.bin_by === 'current_density' || (s.bin_by === null && s.bins.some((b) => b.key.startsWith('j')));
      return byCurrent
        ? { load: width(w, 'j_acm2', EL_SEC_RISE_DEFAULTS.jBinWidth), loadUnit: 'A/cm²', temp: width(w, 'temp_c', EL_SEC_RISE_DEFAULTS.tempBinWidthC) }
        : { load: width(w, 'ac_kw', EL_SEC_RISE_DEFAULTS.powerBinWidthKw), loadUnit: 'kW', temp: width(w, 'temp_c', EL_SEC_RISE_DEFAULTS.tempBinWidthC) };
    }
    case 'comp.sec_rise':
      return { load: width(w, 'pressure_ratio', COMP_SEC_RISE_DEFAULTS.ratioBinWidth), loadUnit: '', temp: width(w, 'ambient_c', COMP_SEC_RISE_DEFAULTS.tempBinWidthC) };
    case 'fc.blower_wear':
      return { load: width(w, 'flow_kg_h', FC_BLOWER_WEAR_DEFAULTS.flowBinWidthKgH), loadUnit: 'kg/h', temp: width(w, 'ambient_c', FC_BLOWER_WEAR_DEFAULTS.tempBinWidthC) };
    case 'ess.resistance_growth':
      return { load: width(w, 'soc_pct', ESS_RESISTANCE_DEFAULTS.socBinWidth), loadUnit: '%', temp: width(w, 'temp_c', ESS_RESISTANCE_DEFAULTS.tempBinWidthC) };
  }
}

function notesOf(detectorId: RiseDetectorId, s: RiseSnapshot, widths: RiseBinWidths): string[] {
  switch (detectorId) {
    case 'el.sec_rise':
      return [`운전 조건 기준: ${widths.loadUnit === 'kW' ? 'AC 전력' : '전류밀도'} bin ${formatNumber(widths.load, 2)} ${widths.loadUnit}`, ...(s.break_in_hours === null ? [] : [`누적 운전 ${formatNumber(s.break_in_hours, 0)} h(break-in) 이후 정상운전만`])];
    case 'comp.sec_rise':
      return s.suction_temp_proxy === null ? [] : [`흡입 가스 온도 대신 외기 온도(${s.suction_temp_proxy})로 나눔`];
    case 'fc.blower_wear':
      return s.affinity_exponent === null ? [] : [s.affinity_exponent > 0 ? `bin 안 유량 차이는 친화 법칙으로 보정 (비전력 × (bin 중심 유량 ÷ 유량)^${formatNumber(s.affinity_exponent, 2)})` : 'bin 안 유량 보정 없음'];
    case 'ess.resistance_growth': {
      const [low, high] = s.soc_range_pct;
      return [
        ...(s.period_s === null ? [] : [`R_${formatNumber(s.period_s, 0)}s = 샘플 주기 ${formatNumber(s.period_s, 0)} s 동안 전압 변화 ÷ 전류 계단 (주기가 다른 계단은 뺌)`]),
        ...(low === undefined || high === undefined ? [] : [`SOC ${formatNumber(low, 0)}~${formatNumber(high, 0)}%${s.min_step_c === null ? '' : ` · |ΔI| ≥ ${formatNumber(s.min_step_c, 2)}C`} 계단만`]),
      ];
    }
  }
}

/** 추세: 표본을 자기 bin 기준 중앙값 대비 %로 바꾼 값의 Theil–Sen (x = 누적 운전시간 h 또는 경과일). 기울기는 x 한 단위당으로 바꾼다 */
function trendOf(detectorId: RiseDetectorId, s: RiseSnapshot): TrendView | null {
  const t = s.trend;
  if (t === null || t.points.length === 0) return null;
  const days = (t.axis ?? (detectorId === 'ess.resistance_growth' ? 'day' : 'op_h')) === 'day';
  const scale = days ? DAYS_PER_MONTH : 1000;
  const unit = t.unit ?? (days ? '%/월' : '%/1000 h');
  const perX = (v: number | null) => (v === null ? null : v / scale);
  return {
    xKind: days ? 'elapsed_days' : 'op_hours',
    yName: `${RISE_META[detectorId].subject} 기준 대비 (%)`,
    points: t.points.map((p) => [p.x, p.pct] as const),
    line: t.line.length >= 2 ? t.line.map((p) => [p.x, p.pct] as const) : null,
    slope: perX(t.slope),
    ciLow: perX(t.ci_low),
    ciHigh: perX(t.ci_high),
    slopeText: t.slope === null ? null : `${formatSigned(t.slope, 2)} ${unit}${t.ci_low === null || t.ci_high === null ? '' : ` (95% CI ${formatSigned(t.ci_low, 2)} ~ ${formatSigned(t.ci_high, 2)})`}`,
    changeStart: t.change_start,
  };
}

export function parseRiseEvidence(snapshot: unknown, detectorId: RiseDetectorId): RiseEvidence {
  const s = RISE.parse(asRecord(snapshot));
  const meta = RISE_META[detectorId];
  const widths = widthsOf(detectorId, s);
  return {
    kind: 'rise',
    detectorId,
    subject: meta.subject,
    levelUnit: meta.levelUnit,
    levelDigits: meta.levelDigits,
    conditionHeader: meta.conditionHeader,
    countWord: meta.countWord,
    // 비교에 쓴 bin을 먼저 (스냅샷 순서는 그대로 유지)
    bins: [...s.bins].sort((a, b) => Number(b.used) - Number(a.used)).map((b) => ({ key: b.key, label: riseBinLabel(detectorId, b.key, widths), nRef: b.n_ref, nCur: b.n_cur, medRef: b.med_ref, medCur: b.med_cur, ratio: b.ratio, used: b.used, refFrom: b.ref_from, refTo: b.ref_to, excluded: b.excluded })),
    reference: s.reference,
    recent: s.recent,
    risePct: s.rise_pct,
    ciLowPct: s.ci_low_pct,
    ciHighPct: s.ci_high_pct,
    trend: trendOf(detectorId, s),
    notes: notesOf(detectorId, s, widths),
    checks: parseChecks(asRecord(snapshot).checks),
  };
}

/** 탐지기 id가 없는 matched_ratio 스냅샷: metric으로 상승 탐지기를 고른다 (용량 감소면 null) */
export function riseDetectorOfMetric(metric: unknown): RiseDetectorId | null {
  if (metric === 'sec_kwh_per_kg') return 'el.sec_rise';
  if (metric === 'comp_sec_kwh_per_kg') return 'comp.sec_rise';
  if (metric === 'blower_specific_power') return 'fc.blower_wear';
  return typeof metric === 'string' && /^R_\d+s$/.test(metric) ? 'ess.resistance_growth' : null;
}
