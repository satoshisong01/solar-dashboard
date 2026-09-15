// P3 판별 체크·같은 조건 비교 엔진의 경계 분기 (탐지기 전체 실행으로 만들기 어려운 상태를 직접 만든다).
import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { TankHoldPoint } from '../episodes/tank-hold';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { binWeightedShift, compareRise, riseEvidence, trendAgrees, type RiseParams, type RiseSample } from './matched-rise';
import type { DerateSample, ThermalCheckInput } from './inv-thermal-samples';
import { thermalChecks } from './inv-thermal-samples';
import { INV_THERMAL_DERATING_DEFAULTS } from './inv-thermal-derating';
import { soilingChecks, type SoilingCheckInput } from './pv-soiling-checks';
import type { PiDay, Segment } from './pv-soiling-days';
import { PV_SOILING_DEFAULTS } from './pv-soiling-rate';
import { tankChecks, type HoldFit, type TankCheckInput } from './tank-static-leak-checks';
import { TANK_STATIC_LEAK_DEFAULTS } from './tank-static-leak';
import { ABEL_NOBLE_DEFAULTS } from './hydrogen-eos';
import { DAY0 } from './test-fixtures';

const statusOf = (checks: readonly { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('compareRise', () => {
  const params: RiseParams = { referencePerBin: 5, maxReferenceSpreadDays: 120, recentDays: 10, minPerBin: 3, minTotal: 6, iterations: 200, sev2Pct: 5, sev3Pct: 10, sev4Pct: 20 };
  const sample = (day: number, value: number, bin: string, axis: number | null = day): RiseSample => ({ start: DAY0 + day * MS_PER_DAY, end: DAY0 + day * MS_PER_DAY + MS_PER_HOUR, value, weight: 1, bin, completeness: 1, axis });
  const samples = Array.from({ length: 40 }, (_, day) => [sample(day, day >= 30 ? 1.12 : 1, 'a'), sample(day, day >= 30 ? 2.24 : 2, 'b')]).flat();

  it('기준 창 모드·추세 없음(축 없음)·기준 0 bin 변화율 없음', () => {
    const windowed = compareRise(samples.map((s) => ({ ...s, axis: null })), { now: DAY0 + 40 * MS_PER_DAY, rng: createRng(1), referenceWindow: { start: DAY0, end: DAY0 + 10 * MS_PER_DAY } }, params, { key: 'day', scale: 1, unit: '%/일' });
    expect(windowed.ok).toBe(true);
    if (!windowed.ok) return;
    expect(windowed.result.split.mode).toBe('window');
    expect(windowed.result.risePct).toBeCloseTo(12, 5);
    expect(windowed.result.severity).toBe(3);
    expect(windowed.result.trend).toBeNull();
    expect(trendAgrees(null)).toBeNull();
    expect(riseEvidence(windowed.result, 2).trend).toBeNull();
    expect(binWeightedShift(windowed.result, () => null)).toBeNull();
    expect(binWeightedShift(windowed.result, (s) => (s.bin === 'a' ? 0 : 1))?.pct).toBeNull();
  });
});

function segment(days: readonly PiDay[], ratePctPerDay: number): Segment {
  return { from: days[0]?.day ?? 0, to: (days.at(-1)?.day ?? 0) + MS_PER_DAY, clearDays: days, slope: -ratePctPerDay / 100, intercept: 1, ciLow: 0, ciHigh: 0, ratePctPerDay, rateCiLow: ratePctPerDay, rateCiHigh: ratePctPerDay };
}

function piDay(day: number, invRates: readonly number[], ghiRatio: number | null, baseDay = 0): PiDay {
  const t = day - baseDay;
  return {
    day: DAY0 + day * MS_PER_DAY,
    pi: 0.85 * (1 - (0.001 * t)),
    acKwh: 1000,
    expectedKwh: 1100,
    clear: true,
    poaKwhM2: 6,
    ghiKwhM2: ghiRatio === null ? null : 6 * ghiRatio,
    inverters: invRates.map((rate, i) => ({ assetId: i + 1, pi: 0.85 * (1 - (rate / 100) * t) })),
  };
}

describe('soilingChecks 경계', () => {
  const base = (days: PiDay[], extra: Partial<SoilingCheckInput> = {}): SoilingCheckInput => ({ days, current: segment(days, 0.1), lossPct: 3, ratePctPerDay: 0.1, lastReset: null, p: PV_SOILING_DEFAULTS, ...extra });

  it('일부 인버터만 저하 → 반박, 절반 남짓 → 불명, 인버터 1대 → 데이터없음; GHI 없음 → 데이터없음; 복원 없음 → 데이터없음', () => {
    const one = Array.from({ length: 20 }, (_, d) => piDay(d, [0.4, 0, 0, 0], null));
    expect(statusOf(soilingChecks(base(one)))).toMatchObject({ site_wide: 'refutes', irradiance_sensor: 'no_data', seasonal_incidence: 'unknown', restoration_recovery: 'no_data' });
    const two = Array.from({ length: 20 }, (_, d) => piDay(d, [0.1, 0.1, 0], 0.85));
    expect(statusOf(soilingChecks(base(two)))).toMatchObject({ site_wide: 'unknown', irradiance_sensor: 'refutes' });
    const single = Array.from({ length: 20 }, (_, d) => piDay(d, [0.1], 0.85));
    expect(statusOf(soilingChecks(base(single))).site_wide).toBe('no_data');
  });

  it('GHI/POA 비율 이동 → 지지·불명, 전년 같은 기간 같은 저하 → 지지·평탄 → 반박, 세척 뒤 회복 없음 → 반박·작음 → 불명', () => {
    const drift = Array.from({ length: 21 }, (_, d) => piDay(365 + d, [0.1, 0.1], d < 7 ? 0.85 : d >= 14 ? 0.85 * 1.05 : 0.85, 365));
    const lastYearSame = Array.from({ length: 21 }, (_, d) => piDay(d, [0.1], 0.85));
    const withHistory = [...lastYearSame, ...drift];
    const checks = statusOf(soilingChecks(base(withHistory, { current: segment(drift, 0.1), lastReset: { day: DAY0 + 365 * MS_PER_DAY, kind: 'cleaning', recoveryPct: 0 } })));
    expect(checks).toMatchObject({ irradiance_sensor: 'supports', seasonal_incidence: 'supports', restoration_recovery: 'refutes' });
    const flatLastYear = Array.from({ length: 21 }, (_, d) => ({ ...piDay(d, [0], 0.85), pi: 0.85 }));
    const mild = Array.from({ length: 21 }, (_, d) => piDay(365 + d, [0.1, 0.1], d >= 14 ? 0.85 * 1.02 : 0.85, 365));
    const flat = statusOf(soilingChecks(base([...flatLastYear, ...mild], { current: segment(mild, 0.1), lastReset: { day: DAY0 + 365 * MS_PER_DAY, kind: 'pi_step', recoveryPct: 1 } })));
    expect(flat).toMatchObject({ irradiance_sensor: 'unknown', seasonal_incidence: 'refutes', restoration_recovery: 'unknown' });
  });
});

describe('tankChecks 경계', () => {
  const point = (h: number): TankHoldPoint => ({ ts: DAY0 + h * MS_PER_HOUR, pressureBar: 300, tempC: 20 });
  const fit = (i: number, loss: number, tempRate: number, hours = 8, downstream: number | null = 0): HoldFit => ({
    hold: { start: DAY0 + i * MS_PER_DAY, end: DAY0 + i * MS_PER_DAY + hours * MS_PER_HOUR, completeness: 1, points: [point(0), point(1)], downstreamRiseBar: downstream },
    hours,
    lossKgPerDay: loss,
    ciLowKgPerDay: loss - 0.05,
    ciHighKgPerDay: loss + 0.05,
    tempRateCPerDay: tempRate,
    tempMeanC: 20,
    pressureMeanBar: 300,
    massMeanKg: 40,
  });
  const input = (fits: HoldFit[], extra: Partial<TankCheckInput> = {}): TankCheckInput => ({ fits, recent: fits.slice(-6), leak: 0.3, volumeM3: 1.85, constants: ABEL_NOBLE_DEFAULTS, p: TANK_STATIC_LEAK_DEFAULTS, ...extra });

  it('손실률이 온도 변화율을 따라가면 온도 보정 지지, 하류 상승 일부 → 불명, 짧은 구간 → 충분성 지지', () => {
    const fits = Array.from({ length: 8 }, (_, i) => fit(i, 0.3 + 0.05 * (i % 4), -2 - 5 * (i % 4), 5, i % 3 === 0 ? 2 : 0));
    const checks = statusOf(tankChecks(input(fits, { crossChecks: [{ ts: DAY0, offsetBar: 0, source: 'compressor_discharge' }] })));
    expect(checks).toEqual({ temperature_compensation: 'supports', pressure_drift: 'no_data', valve_passing: 'unknown', hold_sufficiency: 'supports' });
  });

  it('구간 수는 채웠고 길이가 기준의 1.5~2배면 충분성 불명, 비교 압력 차이가 그대로면 드리프트 반박, 하류 데이터 없음 → 데이터없음', () => {
    const fits = Array.from({ length: 6 }, (_, i) => fit(i, 0.3, -3, 7, null));
    const cross = Array.from({ length: 5 }, (_, i) => ({ ts: DAY0 + i * MS_PER_DAY, offsetBar: 0.2, source: 'peer_tank' as const }));
    expect(statusOf(tankChecks(input(fits, { crossChecks: cross })))).toMatchObject({ temperature_compensation: 'no_data', pressure_drift: 'refutes', valve_passing: 'no_data', hold_sufficiency: 'unknown' });
  });
});

describe('thermalChecks 경계', () => {
  const sample = (i: number, extra: Partial<DerateSample>): DerateSample => ({ ts: DAY0 + i * 300_000, assetId: 4, kwp: 250, own: 0.7, peerMedian: 0.8, heatsinkC: 72, ambientC: 37, limitKnown: true, limited: false, hot: true, derate: true, peersHotShare: 0, peersLimitedShare: 0, bucketHours: 1 / 12, ...extra });
  const rows = (ambient: number) => Array.from({ length: 5 }, (_, d) => ({ day: DAY0 + d * MS_PER_DAY, derateHours: 1, lossKwh: 10, energyKwh: 1000, ambientMaxC: ambient, heatsinkMaxC: 75, coverage: 1 }));
  const input = (samples: DerateSample[], refAmbient: number, curAmbient: number): ThermalCheckInput => ({ inverter: { assetId: 4, dcKwp: 250, derateStartC: null }, recent: rows(curAmbient), reference: rows(refAmbient), samples, input: { siteId: 1, inverters: [], samples: [], faultEvents: [] }, p: INV_THERMAL_DERATING_DEFAULTS });

  it('고온 외기에서만 저감·최근 더 더움 → 외기 지지, 동종도 함께 고온 → 설치 환경 지지, 동종 출력제한 겹침 → 혼동 불명', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, { peersHotShare: 1, peersLimitedShare: i < 5 ? 0.5 : 0 }));
    expect(statusOf(thermalChecks(input(samples, 28, 36)))).toEqual({ ambient_hot: 'supports', fan_fault: 'refutes', installation_environment: 'supports', curtailment_confusion: 'unknown' });
  });

  it('외기 편중 작음 → 불명, 일부 동종만 고온 → 설치 환경 불명, 외기·고온 데이터 없음 → 데이터없음', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, { peersHotShare: i < 5 ? 1 : 0 }));
    expect(statusOf(thermalChecks(input(samples, 34, 36)))).toMatchObject({ ambient_hot: 'unknown', installation_environment: 'unknown' });
    const cold = Array.from({ length: 10 }, (_, i) => sample(i, { hot: false, derate: false, ambientC: null }));
    const noAmbient = { ...input(cold, 0, 0), recent: [], reference: [] };
    expect(statusOf(thermalChecks(noAmbient))).toMatchObject({ ambient_hot: 'no_data', installation_environment: 'no_data' });
  });
});
