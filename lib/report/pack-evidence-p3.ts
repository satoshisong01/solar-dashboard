// P3 근거 표시 모델(lib/desk/p3-evidence.ts) → 팩 근거 요약 (순수). 문장 수치와 ≤120점 요약 시계열만 남긴다.
import { DAYS_PER_MONTH } from '@/lib/analytics/types';
import { formatNumber } from '@/lib/format';
import type { CheckView } from '@/lib/desk/evidence-types';
import type { MassBalanceEvidence, P3EvidenceView, RiseEvidence, SoilingEvidence, TankLeakEvidence, ThermalEvidence } from '@/lib/desk/p3-evidence-types';
import { cleaningEconomics, kstNoonMs, resetKindLabel } from '@/lib/desk/p3-view';
import type { TrendView } from '@/lib/desk/trend';
import { downsamplePoints, roundTo } from './pack-evidence-shared';
import type { PackCheck, PackSeries } from './pack-types';
import type { P3PackEvidence } from './pack-types-p3';

const checksOf = (checks: readonly CheckView[]): PackCheck[] => checks.map((c) => ({ label: c.label, status: c.status }));

/** KST 'YYYY-MM-DD' → 그날 0시 epoch ms (날짜 토큰용) */
const kstMidnight = (date: string | null): number | null => {
  const noon = date === null ? null : kstNoonMs(date);
  return noon === null ? null : noon - 12 * 3_600_000;
};

function timeSeries(points: readonly (readonly [number, number])[], yName: string, yDigits: number): PackSeries | null {
  if (points.length === 0) return null;
  return { xKind: 'time', yName, points: downsamplePoints(points).map(([x, y]) => [x, roundTo(y, yDigits) ?? y] as const), line: null };
}

function trendSeries(trend: TrendView | null): PackSeries | null {
  if (!trend || trend.points.length === 0) return null;
  const pair = ([x, y]: readonly [number, number]): readonly [number, number] => [roundTo(x, trend.xKind === 'time' ? 0 : 1) ?? x, roundTo(y, 3) ?? y];
  return { xKind: trend.xKind, yName: trend.yName, points: downsamplePoints(trend.points).map(pair), line: trend.line ? trend.line.map(pair) : null };
}

const TREND_SCALE: Readonly<Record<TrendView['xKind'], { factor: number; unit: string; axis: string }>> = {
  time: { factor: 1, unit: '', axis: '날짜' },
  op_hours: { factor: 1000, unit: '%/1000 h', axis: '누적 운전시간' },
  elapsed_days: { factor: DAYS_PER_MONTH, unit: '%/월', axis: '경과일' },
};

function rise(e: RiseEvidence): P3PackEvidence {
  const used = e.bins.filter((b) => b.used);
  const scale = TREND_SCALE[e.trend?.xKind ?? 'op_hours'];
  const perUnit = (v: number | null | undefined) => roundTo(v === null || v === undefined ? null : v * scale.factor, 3);
  const labels = used.map((b) => b.label);
  return {
    kind: 'rise',
    subject: e.subject,
    countWord: e.countWord,
    conditionLabel: labels.length <= 3 ? labels.join(' / ') : `${labels.slice(0, 3).join(' / ')} 외 ${formatNumber(labels.length - 3, 0)}개`,
    binCount: used.length,
    nRef: used.reduce((sum, b) => sum + b.nRef, 0),
    nCur: used.reduce((sum, b) => sum + b.nCur, 0),
    trendSlope: perUnit(e.trend?.slope),
    trendCiLow: perUnit(e.trend?.ciLow),
    trendCiHigh: perUnit(e.trend?.ciHigh),
    trendUnit: scale.unit,
    trendAxis: scale.axis,
    series: trendSeries(e.trend),
    checks: checksOf(e.checks),
  };
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

function tank(e: TankLeakEvidence): P3PackEvidence {
  const recent = e.holds.filter((h) => h.role === 'recent');
  return {
    kind: 'tank_leak',
    recentHolds: recent.length,
    referenceHolds: e.holds.length - recent.length,
    medianHoldHours: roundTo(median(recent.flatMap((h) => h.hours ?? [])), 1),
    eosLabel: e.eosModel === 'abel_noble' ? 'Abel–Noble 근사식' : 'NIST 상태식',
    pctPerDay: roundTo(e.pctPerDay, 2),
    noiseSigmaKgPerDay: roundTo(e.noiseSigma, 3),
    thresholdKgPerDay: roundTo(e.thresholdKgPerDay, 3),
    safetyCategory: e.safetyCategory,
    safetyKgPerDay: e.safetyKgPerDay,
    series: timeSeries(e.holds.flatMap((h) => (h.lossKgPerDay === null ? [] : [[h.start, h.lossKgPerDay] as const])), '정지 보유 구간 손실률 (kg/일)', 4),
    checks: checksOf(e.checks),
  };
}

function massBalance(e: MassBalanceEvidence): P3PackEvidence {
  return {
    kind: 'mass_balance',
    recentDays: e.recent.days,
    referenceDays: e.reference.days,
    referenceMedianPct: roundTo(e.reference.medianPct, 2),
    recentMedianKg: roundTo(e.recent.medianKg, 2),
    alarmDay: kstMidnight(e.cusum.alarmDay),
    series: timeSeries(e.days.flatMap((d) => { const x = kstMidnight(d.date); return x === null || d.residualPct === null ? [] : [[x, d.residualPct] as const]; }), '일 잔차율 (%)', 2),
    checks: checksOf(e.checks),
  };
}

function soiling(e: SoilingEvidence): P3PackEvidence {
  const current = e.segments.at(-1);
  const reset = e.resets.at(-1);
  const economics = cleaningEconomics(e);
  return {
    kind: 'soiling',
    ratePctPerDay: roundTo(current?.ratePctPerDay ?? e.ratePctPerDay, 4),
    rateCiLow: roundTo(current?.ciLow ?? null, 4),
    rateCiHigh: roundTo(current?.ciHigh ?? null, 4),
    clearDays: current?.clearDays ?? e.piPoints.length,
    lastResetDay: kstMidnight(reset?.date ?? null),
    lastResetLabel: reset ? resetKindLabel(reset.kind) : null,
    cumulativeLossKwh: roundTo(e.economics.cumulativeLossKwh, 0),
    dailyLossKwh: roundTo(e.economics.dailyLossKwh, 0),
    lossValueKrw: roundTo(economics.lossValueKrw, 0),
    smpKrwPerKwh: roundTo(e.smpKrwPerKwh, 1),
    cleaningCostKrw: e.cleaningCostKrw,
    shareOfCleaningPct: roundTo(economics.shareOfCleaningPct, 0),
    series: timeSeries(e.piPoints.flatMap((p) => { const x = kstMidnight(p.date); return x === null ? [] : [[x, p.pi] as const]; }), '맑은 날 온도 보정 성능지수', 4),
    checks: checksOf(e.checks),
  };
}

function thermal(e: ThermalEvidence): P3PackEvidence {
  return {
    kind: 'thermal',
    days: e.days.length,
    derateDays: e.days.filter((d) => (d.derateH ?? 0) > 0).length,
    derateHours: roundTo(e.days.reduce((sum, d) => sum + (d.derateH ?? 0), 0), 1) ?? 0,
    lossKwh: roundTo(e.days.reduce((sum, d) => sum + (d.lossKwh ?? 0), 0), 0) ?? 0,
    hotC: e.derateStartC === null || e.marginC === null ? null : e.derateStartC - e.marginC,
    gapPct: e.gapPct,
    refBinDerateH: roundTo(e.binShift?.ref ?? null, 2),
    curBinDerateH: roundTo(e.binShift?.cur ?? null, 2),
    series: timeSeries(e.days.flatMap((d) => { const x = kstMidnight(d.date); return x === null || d.derateH === null ? [] : [[x, d.derateH] as const]; }), '일 열 저감 시간 (h)', 2),
    checks: checksOf(e.checks),
  };
}

export function summarizeP3Evidence(view: P3EvidenceView): P3PackEvidence {
  switch (view.kind) {
    case 'rise':
      return rise(view);
    case 'tank_leak':
      return tank(view);
    case 'mass_balance':
      return massBalance(view);
    case 'soiling':
      return soiling(view);
    case 'thermal':
      return thermal(view);
  }
}
