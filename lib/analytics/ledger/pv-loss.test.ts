import { describe, expect, it } from 'vitest';
import { createLedgerContext } from './hourly';
import { resolveLedgerParams } from './params';
import { estimateReferencePr } from './pr-reference';
import { pvLossDay } from './pv-loss';
import { CLEAR_POA, DAY, INVERTER_IDS, PV_ASSETS, pvExpected, pvRows, type PvDaySpec } from './test-fixtures';
import type { LedgerAsset, LedgerHourRow, PrReference, PvLossBreakdown } from './types';

const PR: PrReference = { value: 0.8, method: 'params' };
const [INV01, INV02, INV03, INV04] = INVERTER_IDS;

function lossOf(rows: readonly LedgerHourRow[], options: { assets?: readonly LedgerAsset[]; prRef?: PrReference | null; soiling?: ReadonlyMap<number, number> } = {}) {
  const p = resolveLedgerParams();
  const ctx = createLedgerContext(DAY, options.assets ?? PV_ASSETS, rows, p.fallbackPeriodS);
  return pvLossDay(ctx, p, options.prRef === undefined ? PR : options.prRef, options.soiling ?? new Map());
}

const bucketSum = (b: PvLossBreakdown): number => b.outage + b.ess_full + b.curtailment + b.clipping + b.derating + b.soiling_est + b.unexplained;
const dayExpected = (poa: Readonly<Record<number, number>>, inverters = 4): number => Object.values(poa).reduce((sum, v) => sum + pvExpected(v, PR.value), 0) * inverters;

describe('pvLossDay 버킷 배정', () => {
  it('출력제한·클리핑·트립·ESS 만충·디레이팅이 섞인 날: 버킷별 손계산 값과 합계 = 기대 − 실제', () => {
    const spec: PvDaySpec = {
      poa: CLEAR_POA,
      pr: PR.value,
      soc: { 11: [70, 70], 12: [92, 91] },
      override: (id, h) => {
        if (h === 10 && id === INV01) return { actual: 120, stateMax: 5 }; // 기대 204 → 트립 84
        if (h === 11 && id === INV02) return { actual: 150, limit: 60 }; // 기대 228 → 출력제한 78 (SOC 70%)
        if (h === 12) return { actual: 200, limit: 80 }; // 기대 240 × 4 → ESS 만충 40 × 4
        if (h === 13) return { actual: 250 }; // 기대 276 > 정격 250 → 클리핑 26 × 4
        if (h === 14 && id === INV03) return { actual: 200, heatsink: 76 }; // 동종 중앙값 0.8 kWh/kWp × 300 − 200 → 디레이팅 40
        return undefined;
      },
    };
    const { breakdown, dq } = lossOf(pvRows(spec));
    expect(breakdown).not.toBeNull();
    const b = breakdown as PvLossBreakdown;
    expect(b.outage).toBeCloseTo(84, 3);
    expect(b.curtailment).toBeCloseTo(78, 3);
    expect(b.ess_full).toBeCloseTo(160, 3);
    expect(b.clipping).toBeCloseTo(104, 3);
    expect(b.derating).toBeCloseTo(40, 3);
    expect(b.soiling_est).toBe(0);
    expect(b.unexplained).toBeCloseTo(0, 3);
    expect(b.expected).toBeCloseTo(dayExpected(CLEAR_POA), 3);
    expect(b.expected - b.actual).toBeCloseTo(466, 3);
    expect(bucketSum(b)).toBeCloseTo(b.expected - b.actual, 9);
    expect(dq).toMatchObject({ pr_ref: 0.8, pr_ref_method: 'params', soiling_status: 'not_estimated', temp_corrected_ratio: 1, no_data_inverter_hours: 0, reason: null });
  });

  it('출력제어 날: 제한 시간의 차이는 전부 curtailment, 나머지 버킷은 0', () => {
    const limitedHours = [10, 11, 12, 13, 14];
    const spec: PvDaySpec = {
      poa: CLEAR_POA,
      pr: PR.value,
      override: (_, h) => (limitedHours.includes(h) ? { actual: Math.min(pvExpected(CLEAR_POA[h] ?? 0, PR.value), 125), limit: 50 } : undefined),
    };
    const b = lossOf(pvRows(spec)).breakdown as PvLossBreakdown;
    const curtailed = limitedHours.reduce((sum, h) => sum + Math.max(0, pvExpected(CLEAR_POA[h] ?? 0, PR.value) - 125), 0) * 4;
    expect(b.curtailment).toBeCloseTo(curtailed, 3);
    expect(b.curtailment).toBeCloseTo(2252, 3);
    expect([b.outage, b.ess_full, b.clipping, b.derating, b.soiling_est]).toEqual([0, 0, 0, 0, 0]);
    expect(b.unexplained).toBeCloseTo(0, 3);
  });

  it('흐린 날: 일사가 낮아도 기대만큼 냈으면 손실 버킷은 모두 0, 설명 안 된 차이는 ±1% 안', () => {
    const cloudy = { 7: 60, 8: 120, 9: 180, 10: 240, 11: 250, 12: 210, 13: 190, 14: 150, 15: 110, 16: 70 };
    const spec: PvDaySpec = { poa: cloudy, pr: PR.value, actual: (id, h, expected) => expected * (1 + ((id + h) % 2 === 0 ? 0.01 : -0.01)) };
    const b = lossOf(pvRows(spec)).breakdown as PvLossBreakdown;
    expect([b.outage, b.ess_full, b.curtailment, b.clipping, b.derating, b.soiling_est]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Math.abs(b.unexplained)).toBeLessThan(0.01 * b.expected);
    expect(bucketSum(b)).toBeCloseTo(b.expected - b.actual, 9);
  });

  it('정지·출력 제한 인버터는 디레이팅 동종 기준에서 빠진다 (남는 동종이 3대 미만이면 판정 안 함)', () => {
    const spec: PvDaySpec = {
      poa: { 14: 1000 },
      pr: PR.value,
      override: (id) => (id === INV01 || id === INV02 ? { actual: 120, limit: 50 } : id === INV03 ? { actual: 200, heatsink: 76 } : undefined),
    };
    const b = lossOf(pvRows(spec)).breakdown as PvLossBreakdown;
    expect(b.curtailment).toBeCloseTo(2 * (240 - 120), 3);
    expect(b.derating).toBe(0);
    expect(b.unexplained).toBeCloseTo(40, 3);
  });

  it('오염 손실률이 입력되면 soiling_est, 없으면 0 + 미추정', () => {
    const poa = { ...CLEAR_POA, 13: 1000 }; // 정격 아래 (클리핑 없음)
    const spec: PvDaySpec = { poa, pr: PR.value, actual: (id, _, expected) => (id === INV04 ? expected * 0.95 : expected) };
    const inv04Expected = dayExpected(poa, 1);
    const estimated = lossOf(pvRows(spec), { soiling: new Map([[INV04, 0.03]]) });
    expect(estimated.breakdown?.soiling_est).toBeCloseTo(0.03 * inv04Expected, 3);
    expect(estimated.breakdown?.unexplained).toBeCloseTo(0.02 * inv04Expected, 3);
    expect(estimated.dq.soiling_status).toBe('estimated');
    const unknown = lossOf(pvRows(spec));
    expect(unknown.breakdown?.soiling_est).toBe(0);
    expect(unknown.breakdown?.unexplained).toBeCloseTo(0.05 * inv04Expected, 3);
    expect(unknown.dq.soiling_status).toBe('not_estimated');
  });

  it('정지 코드로 시작·끝난 일사 시간은 outage, 일사가 약하면(< 50 W/m²) 정지로 보지 않는다', () => {
    const spec: PvDaySpec = {
      poa: { 6: 40, 12: 1000 },
      pr: PR.value,
      override: (id, h) => (id === INV02 ? { actual: 0, stateFirst: 1, stateLast: 1 } : h === 6 ? { actual: 0, stateFirst: 0, stateLast: 1 } : undefined),
    };
    const b = lossOf(pvRows(spec)).breakdown as PvLossBreakdown;
    expect(b.outage).toBeCloseTo(pvExpected(1000, PR.value), 3);
    expect(b.unexplained).toBeCloseTo(pvExpected(40, PR.value) * 4, 3);
  });

  it('실제 > 기대(PR_ref 과소)면 unexplained가 음수로 합계를 맞춘다, 온도 보정·출력 결측 처리', () => {
    const over = lossOf(pvRows({ poa: CLEAR_POA, pr: 0.9 })).breakdown as PvLossBreakdown;
    expect(over.unexplained).toBeLessThan(0);
    expect(over.unexplained).toBeCloseTo(over.expected - over.actual, 3);

    const hot = pvRows({ poa: { 12: 1000 }, pr: PR.value, moduleTempC: 45, override: (id) => (id === INV01 ? { noPower: true } : undefined) });
    const warm = lossOf(hot);
    expect(warm.breakdown?.expected).toBeCloseTo(3 * pvExpected(1000, PR.value, 45), 3);
    expect(warm.breakdown?.unexplained).toBeCloseTo(0, 3);
    expect(warm.dq.no_data_inverter_hours).toBe(1);
    const noTemp = lossOf(pvRows({ poa: { 12: 1000 }, pr: PR.value, moduleTempC: null }));
    expect(noTemp.dq.temp_corrected_ratio).toBe(0);
  });

  it('인버터·일사계·PR_ref가 없으면 분해하지 않고 이유를 남긴다', () => {
    const rows = pvRows({ poa: CLEAR_POA, pr: PR.value });
    expect(lossOf(rows, { prRef: null })).toMatchObject({ breakdown: null, dq: { reason: 'pr_ref_missing' } });
    expect(lossOf(rows, { assets: PV_ASSETS.filter((a) => a.classKey !== 'wx.station') })).toMatchObject({ breakdown: null, dq: { reason: 'no_poa' } });
    expect(lossOf(rows, { assets: PV_ASSETS.filter((a) => a.classKey !== 'pv.inverter') })).toMatchObject({ breakdown: null, dq: { reason: 'no_inverter', completeness: null } });
  });
});

describe('estimateReferencePr', () => {
  // 10일: 일사 배율이 큰 3일(맑은 날)은 PR 0.84·0.86·0.85, 나머지 날은 PR 0.70
  const scales = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.98, 1.0, 0.99];
  const prs = [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.84, 0.86, 0.85];
  const scaled = (scale: number) => Object.fromEntries(Object.entries(CLEAR_POA).map(([h, v]) => [h, Math.min(v * scale, 1000)]));
  const rows = scales.flatMap((scale, day) =>
    pvRows({
      day,
      poa: scaled(scale),
      pr: prs[day] ?? 0,
      // 맑은 날 11시 출력제한 구간은 PR 계산에서 뺀다
      override: (_, h) => (day >= 7 && h === 11 ? { actual: 10, limit: 30 } : undefined),
    }),
  );
  const dayStarts = scales.map((_, day) => DAY + day * 86_400_000);

  it('맑은 날(일사 상위 분위) 온도보정 PR의 중앙값, 제한·트립 시간은 제외', () => {
    const estimate = estimateReferencePr({ assets: PV_ASSETS, rows, dayStarts, params: { clearDayQuantile: 0.7 } });
    expect(estimate.reference?.value).toBeCloseTo(0.85, 4);
    expect(estimate.reference?.method).toBe('reference_clear_days');
    expect(estimate).toMatchObject({ clearDays: 3, candidateDays: 10 });
  });

  it('맑은 날이 minClearDays 미만이거나 일사계가 없으면 null', () => {
    expect(estimateReferencePr({ assets: PV_ASSETS, rows, dayStarts, params: { clearDayQuantile: 0.7, minClearDays: 4 } }).reference).toBeNull();
    expect(estimateReferencePr({ assets: PV_ASSETS.filter((a) => a.classKey !== 'wx.station'), rows, dayStarts })).toEqual({ reference: null, clearDays: 0, candidateDays: 0 });
  });
});
