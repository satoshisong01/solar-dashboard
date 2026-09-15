// 기상관측 일 에피소드: wx.day@1 (KST 하루, pv.soiling_rate 입력).
// 입력 메트릭 (기상관측 설비): poa.irradiance(W/m², 필수) · ghi.irradiance(W/m²) · module.temp(°C)
// 특징:
//   poa_kwh_m2        경사면 일적산
//   tmod_weighted_c   일사 가중 모듈 온도 Σ POA·T / Σ POA — 온도 보정 기대발전량이 T에 선형이라 이 값 하나로 정확히 환산된다
//   variability       Σ|ΔPOA| ÷ (2 × 최대 POA). 맑은 날 ≈ 1, 구름이 많을수록 커진다 (샘플 주기가 짧을수록 잡음이 더해진다)
import { MS_PER_DAY, MS_PER_SECOND, kstDateString, kstDayStart } from '../types';
import { goodPoints, holdIntegral, metricDq, nominalPeriodMs, pointsIn, round, roundOrNull, valueNear, type TimedValue } from './series';
import { extractorId, validity, type Episode, type ExtractInput } from './types';

export interface WxDayParams {
  readonly sunIrradiance: number;
  readonly fallbackPeriodS: number;
  readonly minCompleteness: number;
}

export const DEFAULT_WX_DAY_PARAMS: WxDayParams = Object.freeze({ sunIrradiance: 50, fallbackPeriodS: 300, minCompleteness: 0.9 });

export type WxDayFeatures = {
  readonly day: string;
  readonly poa_kwh_m2: number;
  readonly ghi_kwh_m2: number | null;
  readonly tmod_weighted_c: number | null;
  readonly poa_peak_w_m2: number;
  readonly variability: number | null;
  readonly sun_h: number;
};
export type WxDayConditions = Record<string, never>;
export type WxDayEpisode = Episode<'wx.day', WxDayFeatures, WxDayConditions>;

function weightedTemp(poa: readonly TimedValue[], temps: readonly TimedValue[], toleranceMs: number): number | null {
  let weight = 0;
  let sum = 0;
  for (const pt of poa) {
    const t = pt.value > 0 ? valueNear(temps, pt.ts, toleranceMs) : null;
    if (t === null) continue;
    weight += pt.value;
    sum += pt.value * t;
  }
  return weight > 0 ? sum / weight : null;
}

function variabilityOf(poa: readonly TimedValue[]): number | null {
  const peak = Math.max(0, ...poa.map((pt) => pt.value));
  if (!(peak > 0)) return null;
  const travel = poa.slice(1).reduce((sum, pt, i) => sum + Math.abs(pt.value - (poa[i] as TimedValue).value), 0);
  return travel / (2 * peak);
}

/** 원시 샘플 → KST 일별 wx.day 에피소드. 창에 일부만 걸린 날은 open */
export function extractWxDays(input: ExtractInput<unknown>, overrides: Partial<WxDayParams> = {}): WxDayEpisode[] {
  const p = { ...DEFAULT_WX_DAY_PARAMS, ...overrides };
  const poaAll = goodPoints(input.series, 'poa.irradiance');
  if (poaAll.length === 0) return [];
  const ghiAll = goodPoints(input.series, 'ghi.irradiance');
  const temps = goodPoints(input.series, 'module.temp');
  const periodMs = nominalPeriodMs(poaAll, p.fallbackPeriodS * MS_PER_SECOND);
  const ghiPeriodMs = nominalPeriodMs(ghiAll, periodMs);
  const tempTolerance = 1.5 * nominalPeriodMs(temps, periodMs);
  const firstDay = kstDayStart(input.window.start);
  const dayCount = Math.ceil((input.window.end - firstDay) / MS_PER_DAY);
  return Array.from({ length: dayCount }, (_, i): WxDayEpisode => {
    const day = { start: firstDay + i * MS_PER_DAY, end: firstDay + (i + 1) * MS_PER_DAY };
    const poa = pointsIn(poaAll, day);
    const ghi = pointsIn(ghiAll, day);
    const dq = metricDq(input.series['poa.irradiance'], day, periodMs);
    const open = day.start < input.window.start || day.end > input.window.end;
    return {
      assetId: input.assetId,
      kind: 'wx.day',
      extractorVersion: extractorId('wx.day'),
      start: day.start,
      end: day.end,
      features: {
        day: kstDateString(day.start),
        poa_kwh_m2: round(holdIntegral(poa, day, periodMs, 3 * periodMs, (pt) => Math.max(0, pt.value)) / 1000, 4),
        ghi_kwh_m2: ghi.length === 0 ? null : round(holdIntegral(ghi, day, ghiPeriodMs, 3 * ghiPeriodMs, (pt) => Math.max(0, pt.value)) / 1000, 4),
        tmod_weighted_c: roundOrNull(weightedTemp(poa, temps, tempTolerance), 3),
        poa_peak_w_m2: round(Math.max(0, ...poa.map((pt) => pt.value)), 2),
        variability: roundOrNull(variabilityOf(poa), 4),
        sun_h: round(holdIntegral(poa, day, periodMs, 3 * periodMs, (pt) => (pt.value >= p.sunIrradiance ? 1 : 0)), 3),
      },
      conditions: {},
      dq,
      open,
      ...validity(open, dq.completeness, p.minCompleteness),
    };
  });
}
