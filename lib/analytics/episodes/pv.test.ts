import { describe, expect, it } from 'vitest';
import { OP_STATE } from '@/lib/sim/events';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../types';
import { extractPvDays, OP_STATE_FAULT } from './pv';
import { T0, type MutableSeries } from './test-fixtures';

const NAMEPLATE = { ac_kw: 250, dc_kwp: 250 };

interface DayOptions {
  readonly dayOffset: number;
  readonly kw: (hour: number) => number;
  readonly limitPct?: (hour: number) => number;
  readonly fault?: readonly [fromHour: number, toHour: number];
  readonly withPoa?: boolean;
}

/** 06~18시 운전하는 하루 (1분 주기, 밤에도 0 kW 보고) */
function pvDay(options: DayOptions): MutableSeries {
  const series: MutableSeries = { 'ac.power': [], 'ac.power.limit': [], 'op.state': [], 'poa.irradiance': [] };
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const ts = T0 + options.dayOffset * MS_PER_DAY + minute * MS_PER_MINUTE;
    const hour = minute / 60;
    const faulted = options.fault !== undefined && hour >= options.fault[0] && hour < options.fault[1];
    const daylight = hour >= 6 && hour < 18;
    series['ac.power']?.push({ ts, value: daylight && !faulted ? options.kw(hour) : 0, quality: 0 });
    if (minute % 5 === 0) {
      series['ac.power.limit']?.push({ ts, value: options.limitPct?.(hour) ?? 100, quality: 0 });
      series['op.state']?.push({ ts, value: faulted ? OP_STATE_FAULT : daylight ? 3 : 1, quality: 0 });
      if (options.withPoa) series['poa.irradiance']?.push({ ts, value: daylight ? 600 : 0, quality: 0 });
    }
  }
  return series;
}

const extract = (series: MutableSeries, spanMs: number, start = T0) =>
  extractPvDays({ assetId: 3, window: { start, end: start + spanMs }, series, nameplate: NAMEPLATE });

describe('extractPvDays: pv.day@1', () => {
  it('일정 100 kW × 12h → 1,200 kWh, 운전 12h, 플래그 없음', () => {
    const [day] = extract(pvDay({ dayOffset: 0, kw: () => 100, withPoa: true }), MS_PER_DAY);
    expect(day?.extractorVersion).toBe('pv.day@1');
    expect(day?.features).toMatchObject({ day: '2026-06-02', energy_kwh: 1200, kwh_per_kwp: 4.8, operating_h: 12, sun_h: 12, insolation_kwh_m2: 7.2, clipping_ratio: 0, curtailed_h: 0, stopped_h: 0, trip_count: 0 });
    expect(day?.conditions).toEqual({ curtailed: false, clipping: false, stopped: false });
    expect(day).toMatchObject({ open: false, valid: true });
    expect(day?.dq.completeness).toBe(1);
  });

  it('정격 평탄(클리핑)·출력 제한·고장 정지를 구분한다', () => {
    const series = pvDay({
      dayOffset: 0,
      kw: (h) => (h >= 11 && h < 13 ? 250 : 150),
      limitPct: (h) => (h >= 14 && h < 15 ? 60 : 100),
      fault: [16, 16.5],
    });
    const [day] = extract(series, MS_PER_DAY);
    expect(day?.features.clipping_ratio).toBeCloseTo(2 / 11.5, 3);
    expect(day?.features.curtailed_h).toBeCloseTo(1, 6);
    expect(day?.features.trip_count).toBe(1);
    expect(day?.features.stopped_h).toBeCloseTo(0.5, 6);
    expect(day?.features.sun_h).toBeNull();
    expect(day?.conditions).toEqual({ curtailed: true, clipping: true, stopped: true });
  });

  it('창에 일부만 걸린 날은 open, 결측이 많으면 low_completeness', () => {
    const full = pvDay({ dayOffset: 0, kw: () => 80 });
    const sparse: MutableSeries = { 'ac.power': (full['ac.power'] ?? []).filter((_, i) => i % 3 !== 0) };
    const days = extract(sparse, 1.5 * MS_PER_DAY);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ open: false, valid: false, invalidReason: 'low_completeness' });
    expect(days[1]).toMatchObject({ open: true, valid: false, invalidReason: 'open' });
    expect(extract({}, MS_PER_DAY)).toEqual([]);
    expect(OP_STATE_FAULT).toBe(OP_STATE.FAULT);
  });

  it('정격이 없으면 오류', () => {
    expect(() => extractPvDays({ assetId: 1, window: { start: 0, end: MS_PER_HOUR }, series: {}, nameplate: { ac_kw: 0, dc_kwp: 1 } })).toThrow(RangeError);
  });
});
