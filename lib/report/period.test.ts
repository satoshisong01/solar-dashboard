import { describe, expect, it } from 'vitest';
import { currentMonth, currentQuarter, kstDay, parseKstDay, periodRangeLiteral, resolveReportPeriod } from './period';

describe('resolveReportPeriod', () => {
  it('월간: KST 1일 0시 ~ 다음 달 1일 0시', () => {
    const result = resolveReportPeriod({ kind: 'month', month: '2026-12' });
    expect(result).toEqual({ ok: true, period: { kind: 'month', from: Date.UTC(2026, 10, 30, 15), to: Date.UTC(2026, 11, 31, 15), label: '2026년 12월', lastDay: Date.UTC(2026, 11, 30, 15) } });
    if (result.ok) expect(periodRangeLiteral(result.period)).toBe('[2026-11-30T15:00:00.000Z,2026-12-31T15:00:00.000Z)');
  });

  it('분기: 3개월', () => {
    const result = resolveReportPeriod({ kind: 'quarter', year: 2026, quarter: 3 });
    expect(result.ok && [kstDay(result.period.from), kstDay(result.period.lastDay), result.period.label]).toEqual(['2026-07-01', '2026-09-30', '2026년 3분기']);
  });

  it('사용자 지정: 종료일 포함, 366일 초과·역순·없는 날짜는 오류', () => {
    const result = resolveReportPeriod({ kind: 'custom', from: '2026-08-01', to: '2026-08-31' });
    expect(result.ok && [result.period.label, (result.period.to - result.period.from) / 86_400_000]).toEqual(['2026-08-01 ~ 2026-08-31', 31]);
    expect(resolveReportPeriod({ kind: 'custom', from: '2026-08-02', to: '2026-08-01' })).toMatchObject({ ok: false, field: 'to' });
    expect(resolveReportPeriod({ kind: 'custom', from: '2025-01-01', to: '2026-08-01' })).toMatchObject({ ok: false, field: 'from' });
    expect(resolveReportPeriod({ kind: 'custom', from: '2026-02-30', to: '2026-03-01' })).toMatchObject({ ok: false, field: 'from' });
    expect(resolveReportPeriod({ kind: 'month', month: '2026-13' })).toMatchObject({ ok: false, field: 'month' });
    expect(resolveReportPeriod({ kind: 'quarter', year: 2026, quarter: 5 })).toMatchObject({ ok: false, field: 'quarter' });
  });

  it('지금이 속한 달·분기 (KST 기준)', () => {
    const lateAugustUtc = Date.UTC(2026, 7, 31, 16); // KST 9월 1일 01시
    expect(currentMonth(lateAugustUtc)).toBe('2026-09');
    expect(currentQuarter(lateAugustUtc)).toEqual({ year: 2026, quarter: 3 });
    expect(parseKstDay('2026-09-01')).toBe(Date.UTC(2026, 7, 31, 15));
  });
});
