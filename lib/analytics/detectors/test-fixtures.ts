// 탐지기 테스트용 합성 에피소드 (결정적). 원시 → 에피소드 경로는 episodes 테스트가 따로 검증한다.
import type { EssChargeEpisode } from '../episodes/ess';
import type { PvDayEpisode } from '../episodes/pv';
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import { createRng, type Rng } from '@/lib/sim/rng';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';

export const DAY0 = Date.UTC(2026, 0, 1, 1); // 2026-01-01 10:00 KST
export const DQ_FULL = { completeness: 1, missing_ratio: 0, bad_ratio: 0 };

export interface SessionOptions {
  readonly day: number;
  readonly capacityAh: number;
  readonly cRateBin?: number;
  readonly tBin?: number;
  readonly tCell?: number;
  readonly ccAh?: number;
  readonly cvS?: number;
  readonly dvMv?: number;
  readonly socEnd?: number;
  readonly anchored?: boolean;
  /** CC 구간 Ah 보조 용량이 있는 세션 (기본 true) */
  readonly ccCapacity?: boolean;
}

export function chargeSession(o: SessionOptions): EssChargeEpisode {
  const start = DAY0 + o.day * MS_PER_DAY;
  const anchored = o.anchored ?? true;
  return {
    assetId: 7,
    kind: 'ess.charge',
    extractorVersion: 'ess.charge@1',
    start,
    end: start + 8 * MS_PER_HOUR,
    features: {
      ah_in: o.capacityAh * 0.9,
      wh_in: null,
      i_mean_c: (o.cRateBin ?? 0.1) + 0.001,
      t_cell_mean: o.tCell ?? (o.tBin ?? 25) + 1,
      soc_start: 10,
      soc_end: o.socEnd ?? 100,
      soc_ocv_start: 10,
      cc_ah: o.ccAh ?? o.capacityAh * 0.85,
      cv_s: o.cvS ?? 900,
      soc_cv_start: 95,
      duration_s: 8 * 3600,
      cell_dv_end: o.dvMv ?? 8,
      capacity_ah_anchored: anchored ? o.capacityAh : null,
      capacity_ah_cc: (o.ccCapacity ?? true) ? o.capacityAh * 0.99 : null,
      capacity_ah_soc: o.capacityAh * 0.995,
    },
    conditions: { c_rate_bin: o.cRateBin ?? 0.1, t_cell_bin: o.tBin ?? 25, anchor: anchored, pre_rest: true, cv_end: true, end_reason: 'rest' },
    dq: DQ_FULL,
    open: false,
    valid: true,
    invalidReason: null,
  };
}

/** 기준 20회(0~19일) → 20~59일 선형 감소 → 최근 30회(60~89일). bin 4개(C-rate 2 × 온도 2)를 번갈아 쓴다 */
export function capacityHistory(referenceAh: number, recentAh: number, seed: number, extra: Partial<SessionOptions> = {}): EssChargeEpisode[] {
  const rng = createRng(seed);
  const noisy = (ah: number) => ah * (1 + 0.003 * rng.gaussian());
  return Array.from({ length: 90 }, (_, day) => {
    const level = day < 20 ? referenceAh : day >= 60 ? recentAh : referenceAh + ((recentAh - referenceAh) * (day - 20)) / 40;
    return chargeSession({ day, capacityAh: noisy(level), cRateBin: day % 2 === 0 ? 0.1 : 0.15, tBin: day % 4 < 2 ? 20 : 25, ...extra });
  });
}

export function pvDay(assetId: number, day: number, kwhPerKwp: number, flags: Partial<PvDayEpisode['conditions']> = {}): PvDayEpisode {
  const start = DAY0 - 10 * MS_PER_HOUR + day * MS_PER_DAY; // KST 0시
  return {
    assetId,
    kind: 'pv.day',
    extractorVersion: 'pv.day@1',
    start,
    end: start + MS_PER_DAY,
    features: { day: '', energy_kwh: kwhPerKwp * 250, kwh_per_kwp: kwhPerKwp, operating_h: 11, sun_h: null, insolation_kwh_m2: null, clipping_ratio: 0, curtailed_h: 0, stopped_h: 0, trip_count: 0 },
    conditions: { curtailed: false, clipping: false, stopped: false, ...flags },
    dq: DQ_FULL,
    open: false,
    valid: true,
    invalidReason: null,
  };
}

export interface StackSeriesOptions {
  readonly count: number;
  readonly startHours: number;
  readonly endHours: number;
  /** 셀당 전압 변화율 [µV/h] (+ 상승) */
  readonly rateUvPerH: number;
  readonly seed: number;
  readonly noiseMv?: number;
  readonly blowerRise?: number;
}

interface StackSample {
  readonly start: number;
  readonly hours: number;
  readonly j: number;
  readonly t: number;
  readonly v: number;
  readonly blower: number;
}

function stackSamples(o: StackSeriesOptions, base: { v0: number; slopeJ: number; slopeT: number; jMin: number; jSpan: number }, rng: Rng): StackSample[] {
  return Array.from({ length: o.count }, (_, i) => {
    const hours = o.startHours + ((o.endHours - o.startHours) * i) / (o.count - 1);
    const j = base.jMin + base.jSpan * rng.next();
    const t = 55 + 10 * rng.next();
    const v = base.v0 + base.slopeJ * j + base.slopeT * (t - 60) + o.rateUvPerH * 1e-6 * (hours - o.startHours) + ((o.noiseMv ?? 0.3) / 1000) * rng.gaussian();
    const blower = 5 * (1 + ((o.blowerRise ?? 0) * (hours - o.startHours)) / (o.endHours - o.startHours));
    return { start: DAY0 + i * 3 * MS_PER_HOUR, hours, j, t, v, blower };
  });
}

const binOf = (value: number, width: number) => Math.round(Math.floor(value / width + 1e-9) * width * 1e6) / 1e6;

export function elRuns(o: StackSeriesOptions): ElSteadyEpisode[] {
  return stackSamples(o, { v0: 1.45, slopeJ: 0.25, slopeT: -0.004, jMin: 0.6, jSpan: 0.8 }, createRng(o.seed)).map((s) => ({
    assetId: 31,
    kind: 'el.steady_run',
    extractorVersion: 'el.steady_run@1',
    start: s.start,
    end: s.start + MS_PER_HOUR,
    features: { j_mean: s.j, i_mean: s.j * 550, v_cell_mean: s.v, t_stack_mean: s.t, h2_kg: 8, op_hours_cum: s.hours, duration_s: 3600, energy_kwh: 400, dc_kwh: 380, sec_kwh_per_kg: 50 },
    conditions: { j_bin: binOf(s.j, 0.1), t_bin: binOf(s.t, 5) },
    dq: DQ_FULL,
    open: false,
    valid: true,
    invalidReason: null,
  }));
}

export function fcRuns(o: StackSeriesOptions): FcSteadyEpisode[] {
  return stackSamples(o, { v0: 0.85, slopeJ: -0.2, slopeT: 0.002, jMin: 0.3, jSpan: 0.4 }, createRng(o.seed)).map((s) => ({
    assetId: 41,
    kind: 'fc.steady_run',
    extractorVersion: 'fc.steady_run@1',
    start: s.start,
    end: s.start + MS_PER_HOUR,
    features: { j_mean: s.j, i_mean: s.j * 800, v_cell_mean: s.v, v_cell_at_jref: s.v + 0.2 * (s.j - 0.6), t_stack_mean: s.t, h2_kg: 12, op_hours_cum: s.hours, duration_s: 3600, ac_kwh: 200, kg_per_mwh: 60, blower_power_mean: s.blower },
    conditions: { j_bin: binOf(s.j, 0.1), t_bin: binOf(s.t, 5) },
    dq: DQ_FULL,
    open: false,
    valid: true,
    invalidReason: null,
  }));
}
