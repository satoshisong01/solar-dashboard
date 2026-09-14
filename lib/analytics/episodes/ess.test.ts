import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_MINUTE } from '../types';
import { extractEssEpisodes } from './ess';
import { chargeCurve } from './ess-features';
import { essChargeCycle, essDischarge, mergeSeries, T0, type MutableSeries } from './test-fixtures';

const NAMEPLATE = { capacity_ah: 400 };

function extract(series: MutableSeries, spanMs: number, overrides = {}) {
  return extractEssEpisodes({ assetId: 7, window: { start: T0, end: T0 + spanMs }, series, nameplate: NAMEPLATE }, overrides);
}

const cycle = (dayOffset: number, ccHours: number, extra: Partial<Parameters<typeof essChargeCycle>[0]> = {}) =>
  essChargeCycle({ start: T0 + dayOffset * MS_PER_DAY + 60 * MS_PER_MINUTE, restBeforeMin: 90, chargeA: 50, ccHours, taperMin: 15, restAfterMin: 60, socStartPct: 0, ...extra });

describe('extractEssEpisodes: ess.charge@1', () => {
  it('휴지 → 50 A CC 8h → 테이퍼 → 휴지를 한 앵커 세션으로 뽑는다', () => {
    const { charges, discharges, rests } = extract(cycle(0, 8), MS_PER_DAY);
    expect(charges).toHaveLength(1);
    expect(discharges).toHaveLength(0);
    const [charge] = charges;
    const taperAh = Array.from({ length: 15 }, (_, k) => 50 - (41 * k) / 14).reduce((s, i) => s + i / 60, 0);
    expect(charge?.extractorVersion).toBe('ess.charge@1');
    expect(charge?.features.ah_in).toBeCloseTo(400 + taperAh, 6);
    // 테이퍼 시작 = CC 전류의 90%(45 A) 아래로 끝까지 내려간 첫 샘플 (테이퍼 3번째 샘플)
    expect(charge?.features.cc_ah).toBeCloseTo(400 + (50 + (50 - 41 / 14)) / 60, 6);
    expect(charge?.features.cv_s).toBe(13 * 60);
    expect(charge?.features.duration_s).toBe((8 * 60 + 15) * 60);
    expect(charge?.features.i_mean_c).toBeCloseTo(0.125, 3);
    expect(charge?.features.soc_start).toBe(0);
    expect(charge?.features.soc_end).toBeCloseTo(100, 6);
    expect(charge?.features.cell_dv_end).toBeCloseTo(5, 6);
    expect(charge?.features.wh_in).toBeGreaterThan(0);
    expect(charge?.features.capacity_ah_anchored).toBeCloseTo(400 + taperAh, 6);
    expect(charge?.features.capacity_ah_cc).toBeGreaterThan(390);
    expect(charge?.features.capacity_ah_soc).toBeCloseTo(400 + taperAh, 6);
    expect(charge?.conditions).toEqual({ c_rate_bin: 0.1, t_cell_bin: 25, anchor: true, pre_rest: true, cv_end: true, end_reason: 'rest' });
    expect(charge).toMatchObject({ open: false, valid: true, invalidReason: null });
    expect(charge?.dq.completeness).toBe(1);
    // 앞 휴지는 충전 시작에서, 뒤 휴지는 데이터 끝에서 닫힌다
    expect(rests.map((r) => r.conditions.end_reason)).toEqual(['reversal', 'data_end']);
  });

  it('설계 §3.1: 같은 50 A로 8h vs 7.5h 충전 → 유효용량 비율 0.9375 ± 0.01', () => {
    const series = mergeSeries(cycle(0, 8), cycle(1, 7.5));
    const { charges } = extract(series, 2 * MS_PER_DAY);
    const [reference, recent] = charges.map((c) => c.features.capacity_ah_anchored ?? Number.NaN);
    expect(charges.every((c) => c.conditions.anchor)).toBe(true);
    expect((recent ?? 0) / (reference ?? 1)).toBeGreaterThan(0.9275);
    expect((recent ?? 0) / (reference ?? 1)).toBeLessThan(0.9475);
  });

  it('시작 SOC가 20%를 넘거나 휴지 없이 시작하면 앵커가 아니다', () => {
    const high = extract(cycle(0, 6, { socStartPct: 30 }), MS_PER_DAY).charges[0];
    expect(high?.conditions.anchor).toBe(false);
    expect(high?.features.capacity_ah_anchored).toBeNull();
    const noRest = extract(cycle(0, 6, { restBeforeMin: 20 }), MS_PER_DAY).charges[0];
    expect(noRest?.conditions.pre_rest).toBe(false);
    expect(noRest?.features.soc_ocv_start).toBeNull();
  });

  it('2분 넘는 데이터 공백에서 끊고 뒤 조각은 휴지 후 시작이 아니다', () => {
    const { charges } = extract(cycle(0, 4, { gapMinutes: [200, 210] }), MS_PER_DAY);
    expect(charges).toHaveLength(2);
    expect(charges[0]?.conditions.end_reason).toBe('gap');
    expect(charges[1]?.conditions.pre_rest).toBe(false);
  });

  it('품질 불량 샘플이 많으면 완결성이 낮아 무효', () => {
    const [charge] = extract(cycle(0, 4, { badEvery: 3 }), MS_PER_DAY).charges;
    expect(charge?.dq.completeness).toBeLessThan(0.8);
    expect(charge?.dq.bad_ratio).toBeGreaterThan(0.3);
    expect(charge).toMatchObject({ valid: false, invalidReason: 'low_completeness' });
    expect(charge?.conditions.anchor).toBe(false);
  });

  it('창 끝까지 충전 중이면 open·무효', () => {
    const [charge] = extract(cycle(0, 8), 5 * 60 * MS_PER_MINUTE).charges;
    expect(charge).toMatchObject({ open: true, valid: false, invalidReason: 'open' });
    expect(charge?.conditions.end_reason).toBe('data_end');
  });

  it('2분 미만 블립은 시작하지 않고, 5분 미만 휴지는 한 세션으로 병합한다', () => {
    const series: MutableSeries = { 'batt.current': [], 'batt.voltage': [], 'batt.soc': [] };
    const profile = [...Array(30).fill(0), 50, ...Array(20).fill(0), ...Array(60).fill(50), ...Array(3).fill(0), ...Array(60).fill(50), ...Array(30).fill(0)];
    profile.forEach((current: number, minute) => {
      const ts = T0 + minute * MS_PER_MINUTE;
      series['batt.current']?.push({ ts, value: current, quality: 0 });
      series['batt.voltage']?.push({ ts, value: 830, quality: 0 });
      series['batt.soc']?.push({ ts, value: 50, quality: 0 });
    });
    const { charges } = extract(series, 5 * 60 * MS_PER_MINUTE);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.features.duration_s).toBe(123 * 60);
    expect(charges[0]?.features.ah_in).toBeCloseTo(100, 9);
    expect(charges[0]?.conditions.cv_end).toBe(false);
    expect(charges[0]?.features.t_cell_mean).toBeNull();
  });

  it('정격 용량이 없으면 오류, 전류가 없으면 빈 결과', () => {
    expect(() => extractEssEpisodes({ assetId: 1, window: { start: 0, end: 1 }, series: {}, nameplate: { capacity_ah: 0 } })).toThrow(RangeError);
    expect(extract({}, MS_PER_DAY)).toEqual({ charges: [], discharges: [], rests: [] });
  });
});

describe('extractEssEpisodes: ess.discharge@1 · ess.rest@1', () => {
  it('방전 Ah는 양수, 휴지 특징', () => {
    const { discharges, rests } = extract(essDischarge(T0 + 60 * MS_PER_MINUTE, 100, 60), MS_PER_DAY);
    expect(discharges).toHaveLength(1);
    expect(discharges[0]?.features.ah_out).toBeCloseTo(100, 9);
    expect(discharges[0]?.features.wh_out).toBeCloseTo(100 * 830, 6);
    expect(discharges[0]?.features.i_mean_c).toBeCloseTo(0.25, 9);
    expect(discharges[0]?.conditions).toMatchObject({ c_rate_bin: 0.25, t_cell_bin: 20, pre_rest: false, end_reason: 'rest' });
    expect(rests).toHaveLength(2);
    expect(rests[1]?.features).toMatchObject({ duration_s: 600, soc_mean: 50, t_cell_mean: 24, v_end: 830 });
    expect(rests[1]?.features.cell_dv_end).toBeCloseTo(10, 6);
  });
});

describe('chargeCurve', () => {
  it('t=0 정렬, 누적 Ah가 끝에서 ah_in과 같고 120점 이하', () => {
    const series = cycle(0, 8);
    const [charge] = extract(series, MS_PER_DAY).charges;
    const curve = chargeCurve(series, { start: charge?.start ?? 0, end: charge?.end ?? 0 });
    expect(curve.length).toBeLessThanOrEqual(120);
    expect(curve[0]).toEqual({ elapsed_s: 0, ah: 0, soc: 0 });
    expect(curve[curve.length - 1]?.ah).toBeCloseTo(charge?.features.ah_in ?? 0, 2);
    expect(curve[curve.length - 1]?.elapsed_s).toBe(charge?.features.duration_s);
    expect(chargeCurve({}, { start: 0, end: 10 })).toEqual([]);
  });
});
