// P3 근거 파서: demo 분석이 저장한 스냅샷(정상) · 근거 확장 이전 스냅샷(옛) · 타입이 틀린 스냅샷(손상) · 탐지기 출력 계약.
import { describe, expect, it } from 'vitest';
import { h2ChainMassBalanceGap, type H2LedgerDayInput } from '@/lib/analytics/detectors/h2chain-mass-balance';
import { DAY0 } from '@/lib/analytics/detectors/test-fixtures';
import { DAYS_PER_MONTH, kstDayStart, MS_PER_DAY } from '@/lib/analytics/types';
import { createRng } from '@/lib/sim/rng';
import { parseEvidence } from './evidence';
import { parseP3Evidence } from './p3-evidence';
import { BLOWER_SNAPSHOT, COMP_SEC_RISE_SNAPSHOT, EL_SEC_RISE_SNAPSHOT, MASS_BALANCE_SNAPSHOT_V1, RESISTANCE_SNAPSHOT, SOILING_SNAPSHOT_V1, TANK_LEAK_SNAPSHOT, THERMAL_SNAPSHOT } from './p3-evidence-fixtures';

const kindOf = <K extends string>(view: { kind: string } | null, kind: K) => {
  if (view?.kind !== kind) throw new Error(`${kind}가 아닙니다: ${view?.kind}`);
  return view as Extract<NonNullable<ReturnType<typeof parseP3Evidence>>, { kind: K }>;
};

describe('상승 탐지기 4종 (matched_ratio)', () => {
  it('el.sec_rise: AC 전력 bin 라벨·운전시간 축 기울기(%/1000 h → %/h)·메모·체크', () => {
    const view = kindOf(parseP3Evidence(EL_SEC_RISE_SNAPSHOT), 'rise');
    expect(view.detectorId).toBe('el.sec_rise');
    expect(view.bins.find((b) => b.key === 'P450|60')?.label).toBe('450~500 kW · 60~65 °C');
    expect(view.levelUnit).toBe('kWh/kg');
    expect(view.trend).toMatchObject({ xKind: 'op_hours', changeStart: 1340.76 });
    expect(view.trend?.slope).toBeCloseTo(10.4427 / 1000, 9);
    expect(view.trend?.slopeText).toBe('+10.44 %/1000 h (95% CI +9.5 ~ +11.27)');
    expect(view.notes[0]).toBe('운전 조건 기준: AC 전력 bin 50 kW');
    expect(view.checks.map((c) => c.id)).toContain('rectifier_efficiency');
    expect(view.reference.n).toBeGreaterThan(0);
  });

  it('comp.sec_rise·fc.blower_wear·ess.resistance_growth: 탐지기별 조건 라벨·단위·추세 축', () => {
    const comp = kindOf(parseP3Evidence(COMP_SEC_RISE_SNAPSHOT), 'rise');
    expect(comp.bins[0]?.label).toBe('12~14 · 20~25 °C');
    expect(comp.notes).toEqual(['흡입 가스 온도 대신 외기 온도(ambient.temp)로 나눔']);
    const blower = kindOf(parseP3Evidence(BLOWER_SNAPSHOT), 'rise');
    expect(blower.bins[0]?.label).toBe('600~700 kg/h · 25~30 °C');
    expect(blower.levelUnit).toBe('W/(kg/h)');
    const rack = kindOf(parseP3Evidence(RESISTANCE_SNAPSHOT), 'rise');
    expect(rack.bins[0]?.label).toBe('80~90% · 20~25 °C');
    expect(rack.trend?.xKind).toBe('elapsed_days');
    expect(rack.trend?.slope).toBeCloseTo(27.4949 / DAYS_PER_MONTH, 9);
    expect(rack.notes[0]).toContain('R_60s');
  });

  it('탐지기 id가 없으면 metric으로 고르고, 용량 감소 스냅샷은 P3가 아니다', () => {
    const noDetector = Object.fromEntries(Object.entries(BLOWER_SNAPSHOT).filter(([key]) => key !== 'detector'));
    expect(parseP3Evidence(noDetector)?.kind).toBe('rise');
    expect(parseP3Evidence({ method: 'matched_ratio', metric: 'capacity_ah_soc' })).toBeNull();
    expect(parseP3Evidence(EL_SEC_RISE_SNAPSHOT, 'ess.capacity_fade')).toBeNull();
    expect(parseEvidence({ method: 'matched_ratio', metric: 'capacity_ah_soc', bins: [] }, 'ess.capacity_fade').kind).toBe('capacity');
    expect(parseEvidence(EL_SEC_RISE_SNAPSHOT, 'el.sec_rise').kind).toBe('rise');
  });

  it('손상: bin 폭이 없으면 기본값, 깨진 bin·추세 점은 빼고 값은 null', () => {
    const view = kindOf(parseP3Evidence({ detector: 'el.sec_rise@1', bins: [{ key: 'j0.5|na', n_ref: 'x' }, { n_ref: 3 }], trend: { points: [{ x: 1, pct: 'bad' }, { x: 2, pct: 3 }] }, rise_pct: 'NaN' }), 'rise');
    expect(view.bins).toHaveLength(1);
    expect(view.bins[0]).toMatchObject({ label: '0.5~0.6 A/cm² · 스택 온도 없음', nRef: 0, medRef: null, used: false });
    expect(view.trend?.points).toEqual([[2, 3]]);
    expect(view.trend?.line).toBeNull();
    expect(view.risePct).toBeNull();
    expect(view.checks).toEqual([]);
  });
});

describe('tank.static_leak', () => {
  it('정상: 결합 누설률·유의 기준·안전 기준·구간 표·대표 곡선', () => {
    const view = kindOf(parseP3Evidence(TANK_LEAK_SNAPSHOT), 'tank_leak');
    expect(view).toMatchObject({ eosModel: 'lemmon2008', volumeM3: 1.85, leakKgPerDay: 1.0328, safetyCategory: true, safetyKgPerDay: 0.5, thresholdKgPerDay: 0.1296, seKgPerDay: 0.0432 });
    expect(view.holds.length).toBeGreaterThan(0);
    expect(view.holds[0]).toMatchObject({ role: 'reference', hours: 8.08 });
    expect(view.representative?.points[0]).toEqual({ ts: 1789048800000, pBar: 313.34, tC: 22.09, massKg: 39.7258 });
    expect(view.checks).toHaveLength(4);
  });

  it('손상·옛: 필드가 없거나 타입이 틀려도 던지지 않고 null·빈 배열', () => {
    const view = kindOf(parseP3Evidence({ method: 'static_hold_theil_sen_weighted_median', combined: 'x', holds: [{ role: 'recent', start: 'bad' }, { role: 'recent', start: 5, loss_kg_per_day: 'NaN' }], representative: { start: 1 } }), 'tank_leak');
    expect(view).toMatchObject({ leakKgPerDay: null, eosModel: null, safetyCategory: false, representative: null, biasKgPerDay: null });
    expect(view.holds).toEqual([{ role: 'recent', start: 5, hours: null, lossKgPerDay: null, ciLow: null, ciHigh: null, tMeanC: null, tRateCPerDay: null, pMeanBar: null }]);
  });
});

describe('h2chain.mass_balance_gap', () => {
  it('옛 스냅샷: 일 행에 원장 항이 없고 CUSUM 경로가 비어 있다', () => {
    const view = kindOf(parseP3Evidence(MASS_BALANCE_SNAPSHOT_V1), 'mass_balance');
    expect(view.hasBalanceTerms).toBe(false);
    expect(view.cusum).toMatchObject({ direction: 'up', alarmDay: '2026-08-16', k: 0.5, h: 4, points: [] });
    expect(view.days[0]).toMatchObject({ date: '2026-05-18', produced: 11.26, fcConsumed: null, residualPct: 0.68 });
    expect(view.recent).toMatchObject({ days: 6, medianPct: 2.284 });
  });

  it('탐지기 출력 계약: 일 원장 항·완결성·CUSUM 경로(경보 방향 누적합)와 기준 σ를 읽는다', () => {
    const first = kstDayStart(DAY0);
    const rng = createRng(4);
    const days: H2LedgerDayInput[] = Array.from({ length: 60 }, (_, day) => {
      const produced = 100 + 5 * rng.next();
      const pct = (day >= 35 ? 4 : 0) + 0.3 * rng.gaussian();
      const residual = (produced * pct) / 100;
      return { day: first + day * MS_PER_DAY, produced, fc_consumed: 45, stored_delta: produced - 45 - 0.5 - residual, vented_est: 0.5, residual, residual_pct: pct, dq: { completeness: 1 } };
    });
    const result = h2ChainMassBalanceGap.detect({ siteId: 1, days }, { now: first + 60 * MS_PER_DAY, rng: createRng(1), params: {} });
    const snapshot = result.status === 'ok' ? result.findings[0]?.evidence : undefined;
    const view = kindOf(parseP3Evidence(snapshot), 'mass_balance');
    expect(view.hasBalanceTerms).toBe(true);
    expect(view.days[0]).toMatchObject({ fcConsumed: 45, ventedEst: 0.5, completeness: 1 });
    expect(view.cusum.points.length).toBeGreaterThan(40);
    expect(Math.max(...view.cusum.points.map((p) => p.s))).toBeGreaterThan(view.cusum.h ?? Infinity);
    expect(view.reference.sigmaPct).toBeGreaterThan(0);
  });

  it('손상: 날짜가 없는 일 행은 빼고 방향이 틀리면 null', () => {
    const view = kindOf(parseP3Evidence({ method: 'residual_median_cusum', days: [{ produced: 1 }, { date: '2026-09-01', residual: '1' }], cusum: { direction: 'sideways' } }), 'mass_balance');
    expect(view.days).toEqual([{ date: '2026-09-01', produced: null, fcConsumed: null, storedDelta: null, ventedEst: null, residual: null, residualPct: null, completeness: null }]);
    expect(view.cusum.direction).toBeNull();
    expect(view.reference.days).toBe(0);
  });
});

describe('pv.soiling_rate', () => {
  it('옛 스냅샷: 구간 기울기선이 없어 현재 구간 선만, 제외 사유는 0보다 큰 것만', () => {
    const view = kindOf(parseP3Evidence(SOILING_SNAPSHOT_V1), 'soiling');
    expect(view.segments.map((s) => s.line)).toEqual([null, null]);
    expect(view.currentLine).toHaveLength(2);
    expect(view.resets).toEqual([{ date: '2026-07-06', kind: 'pi_step', recoveryPct: 3.16 }]);
    expect(view.exclusions).toEqual([['stopped', 5], ['cloudy_days', 99], ['peer_outlier', 50]]);
    expect(view.economics).toEqual({ cumulativeLossKwh: 4114.2, dailyLossKwh: 127.3, lossValueKrw: null });
  });

  it('정상(구간선 있음)·손상(선 점 1개는 선 없음)', () => {
    const line = [{ date: '2026-07-06', pi: 0.935 }, { date: '2026-09-12', pi: 0.9 }];
    const view = kindOf(parseP3Evidence({ ...SOILING_SNAPSHOT_V1, segments: [{ from: '2026-07-06', to: '2026-09-15', clear_days: 11, rate_pct_per_day: 0.05, line }, { from: 'x', to: 'y', line: [line[0]] }] }), 'soiling');
    expect(view.segments[0]?.line).toEqual(line);
    expect(view.segments[1]).toMatchObject({ clearDays: 0, line: null, ratePctPerDay: null });
  });
});

describe('inv.thermal_derating', () => {
  it('정상: 일별 저감·외기 bin·대표일', () => {
    const view = kindOf(parseP3Evidence(THERMAL_SNAPSHOT), 'thermal');
    expect(view).toMatchObject({ derateStartC: 70, marginC: 5, gapPct: 5, binShift: { ref: 0.176, cur: 0.218 } });
    expect(view.ambientBins.map((b) => b.binC)).toEqual([20, 25, 30]);
    expect(view.days[0]).toEqual({ date: '2026-08-16', derateH: 1.5, lossKwh: 26.6, ambientMaxC: 30.8 });
    expect(view.representativeDay?.unit).toBe('kW/kWp');
    expect(view.checks).toHaveLength(4);
  });

  it('손상: 대표일 형식이 틀리면 null, bin 키가 없으면 그 bin만 뺀다', () => {
    const view = kindOf(parseP3Evidence({ detector: 'inv.thermal_derating@1', ambient_bins: [{ n_ref: 1 }, { ambient_bin_c: 30 }], representative_day: 'x', ambient_bin_shift_h: { ref: 'a' } }), 'thermal');
    expect(view.ambientBins).toEqual([{ binC: 30, nRef: 0, nCur: 0, refDerateH: null, curDerateH: null }]);
    expect(view.representativeDay).toBeNull();
    expect(view.binShift).toBeNull();
    expect(view.days).toEqual([]);
  });
});
