// 리포트 기간: 월간·분기·사용자 지정 → [from, to) (KST 날짜 경계). 순수 모듈 (서버·클라이언트 공용).
// DB om.report.period는 tstzrange '[from,to)'로 저장한다.
import type { PackPeriod, ReportPeriodKind } from './pack-types';

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
/** 사용자 지정 기간 상한 [일] */
export const MAX_REPORT_DAYS = 366;

export type PeriodSpec =
  | { readonly kind: 'month'; readonly month: string }
  | { readonly kind: 'quarter'; readonly year: number; readonly quarter: number }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string };

export type PeriodResult = { readonly ok: true; readonly period: PackPeriod } | { readonly ok: false; readonly field: string; readonly error: string };

const kstDateMs = (year: number, monthIndex: number, day: number): number => Date.UTC(year, monthIndex, day) - KST_OFFSET_MS;
const pad = (n: number): string => String(n).padStart(2, '0');

/** KST 0시 epoch ms → 'YYYY-MM-DD' */
export function kstDay(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' (달력에 있는 날짜만) → KST 0시 epoch ms */
export function parseKstDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 2000 || year > 2100) return null;
  return kstDateMs(year, month - 1, day);
}

const periodOf = (kind: ReportPeriodKind, from: number, to: number, label: string): PackPeriod => ({ kind, from, to, label, lastDay: to - DAY_MS });

export function resolveReportPeriod(spec: PeriodSpec): PeriodResult {
  switch (spec.kind) {
    case 'month': {
      const match = /^(\d{4})-(\d{2})$/.exec(spec.month.trim());
      const [year, month] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
      if (!match || month < 1 || month > 12 || year < 2000 || year > 2100) return { ok: false, field: 'month', error: '월을 YYYY-MM 형식으로 고르세요' };
      return { ok: true, period: periodOf('month', kstDateMs(year, month - 1, 1), kstDateMs(year, month, 1), `${year}년 ${month}월`) };
    }
    case 'quarter': {
      if (!Number.isInteger(spec.year) || spec.year < 2000 || spec.year > 2100) return { ok: false, field: 'year', error: '연도를 2000~2100 사이로 입력하세요' };
      if (!Number.isInteger(spec.quarter) || spec.quarter < 1 || spec.quarter > 4) return { ok: false, field: 'quarter', error: '분기를 고르세요' };
      const startMonth = (spec.quarter - 1) * 3;
      return { ok: true, period: periodOf('quarter', kstDateMs(spec.year, startMonth, 1), kstDateMs(spec.year, startMonth + 3, 1), `${spec.year}년 ${spec.quarter}분기`) };
    }
    case 'custom': {
      const from = parseKstDay(spec.from);
      const last = parseKstDay(spec.to);
      if (from === null) return { ok: false, field: 'from', error: '시작일을 YYYY-MM-DD로 입력하세요' };
      if (last === null) return { ok: false, field: 'to', error: '종료일을 YYYY-MM-DD로 입력하세요' };
      if (last < from) return { ok: false, field: 'to', error: '종료일은 시작일과 같거나 뒤여야 합니다' };
      const to = last + DAY_MS;
      if (to - from > MAX_REPORT_DAYS * DAY_MS) return { ok: false, field: 'from', error: `리포트 기간은 ${MAX_REPORT_DAYS}일 이하여야 합니다` };
      return { ok: true, period: periodOf('custom', from, to, `${kstDay(from)} ~ ${kstDay(last)}`) };
    }
  }
}

/** 지금이 속한 달 'YYYY-MM' (KST) */
export function currentMonth(nowMs: number): string {
  return kstDay(nowMs).slice(0, 7);
}

/** 지금이 속한 분기 (KST) */
export function currentQuarter(nowMs: number): { readonly year: number; readonly quarter: number } {
  const [year, month] = kstDay(nowMs).split('-').map(Number);
  return { year: year ?? 2000, quarter: Math.floor(((month ?? 1) - 1) / 3) + 1 };
}

/** tstzrange 입력 리터럴 */
export function periodRangeLiteral(period: Pick<PackPeriod, 'from' | 'to'>): string {
  return `[${new Date(period.from).toISOString()},${new Date(period.to).toISOString()})`;
}
