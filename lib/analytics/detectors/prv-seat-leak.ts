// prv.seat_leak@1 — 수소 감압밸브 시트 누설 (락업 크리프).
// 연료전지가 멈춰 하류로 흐름이 없는 hold 구간에서 하류 압력이 계속 오르면 시트가 새는 것이다.
// 판정: 최근 recentHolds개 hold의 Theil–Sen 기울기 중앙값 > creepBarPerH 이고, 그런 hold가 minAlarmHolds개 이상 연속.
// 판별 체크: ① 공급압 효과(상류 압력이 떨어지는 동안 설정압이 오르는 현상 — 최대 오탐원) ② 온도 상승 ③ 설정값 재조정 ④ 계측 분해능 ⑤ hold 길이.
// 안전 판단(운전 정지·PSV 점검)은 현장 안전책임자와 인터록의 몫이다.
//
// 근거: docs/renewal/research/pid/research-pressure.{json,md} — 락업 크리프 경고 13 mbar/h(하류 0.5 m³ 기준 약 0.1 NL/min),
//       주의 130 mbar/h(약 1 NL/min). 공급압 효과는 EN 334 AC/SG 등급에 따라 설정압이 +3~219%까지 움직인다.
import * as z from 'zod';
import type { PrvHold, PrvHoldHour } from '../episodes/gapyeong-samples';
import { downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { MAD_TO_SIGMA, mad, median } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { kstDateString, MS_PER_DAY, type JsonObject } from '../types';
import { levelCheck, makeCheck, medianOrNull, pearson, SAFETY_DISCLAIMER } from './check-helpers';
import { fixed, insufficient, r, severityByMagnitude, withDefaults } from './common';
import { completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import { recommended, required, SLOW_S } from './requirements';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult, DiagnosticCheck, Severity } from './types';

export interface PrvSeatLeakInput {
  readonly assetId: number;
  /** 명판 출구 설정 압력 [bar]. 없으면 hold 시작 압력을 기준으로 본다 */
  readonly outletSetBar: number | null;
  /** 명판 하류 밀폐 체적 [m³]. 있으면 크리프율을 NL/min으로 환산해 근거에 남긴다 */
  readonly downstreamVolumeM3: number | null;
  readonly holds: readonly PrvHold[];
}

export interface PrvSeatLeakParams {
  readonly creepBarPerH: number;
  readonly severeCreepBarPerH: number;
  readonly minHoldHours: number;
  readonly recentHolds: number;
  readonly minAlarmHolds: number;
  readonly referenceHolds: number;
  readonly recentDays: number;
  readonly minCompleteness: number;
  readonly supplyCorrelationR: number;
  readonly temperatureCorrelationR: number;
  readonly setpointChangeBar: number;
  /** 하류 압력 잡음(MAD→σ)이 크리프율 × 이 배수보다 크면 계측 분해능 체크가 지지 */
  readonly resolutionSigmaFactor: number;
  readonly iterations: number;
}

export const PRV_SEAT_LEAK_DEFAULTS: PrvSeatLeakParams = Object.freeze({
  creepBarPerH: 0.013,
  severeCreepBarPerH: 0.13,
  minHoldHours: 3,
  recentHolds: 6,
  minAlarmHolds: 3,
  referenceHolds: 10,
  recentDays: 30,
  minCompleteness: 0.9,
  supplyCorrelationR: 0.7,
  temperatureCorrelationR: 0.7,
  setpointChangeBar: 0.02,
  resolutionSigmaFactor: 2,
  iterations: 1000,
});

const D = PRV_SEAT_LEAK_DEFAULTS;
export const PRV_SEAT_LEAK_PARAM_SCHEMA = z.object({
  creepBarPerH: numParam(D.creepBarPerH, { label: '크리프 경고 기준', unit: 'bar/h', min: 0.001, max: 5, description: '무유동 구간 하류 압력 상승률이 이 값을 넘으면 finding입니다 (하류 0.5 m³ 기준 13 mbar/h ≈ 0.1 NL/min).' }),
  severeCreepBarPerH: numParam(D.severeCreepBarPerH, { label: '크리프 주의 기준', unit: 'bar/h', min: 0.001, max: 20, description: '이 값을 넘으면 심각도를 올립니다 (약 1 NL/min).' }),
  minHoldHours: intParam(D.minHoldHours, { label: '최소 hold 길이', unit: '시간', min: 2, max: 48, description: '이보다 짧은 무유동 구간은 기울기를 신뢰할 수 없어 뺍니다.' }),
  recentHolds: intParam(D.recentHolds, { label: '최근 hold 수', unit: '개', min: 2, max: 60, description: '크리프율 중앙값을 보는 최근 hold 개수입니다.' }),
  minAlarmHolds: intParam(D.minAlarmHolds, { label: '연속 경고 hold 수', unit: '개', min: 1, max: 20, description: '최근 hold 중 기준을 넘은 것이 이 수 이상이어야 finding으로 올립니다 (1회 경고로는 정비 요청을 만들지 않습니다).' }),
  referenceHolds: intParam(D.referenceHolds, { label: '기준 hold 수', unit: '개', min: 2, max: 120, description: '최근 구간 앞의 hold 중 기준 크리프율을 잡는 개수입니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 3, max: 180, description: '최근 hold를 고르는 기간입니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  supplyCorrelationR: numParam(D.supplyCorrelationR, { label: '공급압 상관 기준', unit: '', min: 0.1, max: 1, description: '상류 압력이 떨어질 때 하류 압력이 오르는 상관(음의 상관)이 이 값 이상이면 공급압 효과 체크를 지지로 봅니다.' }),
  temperatureCorrelationR: numParam(D.temperatureCorrelationR, { label: '온도 상관 기준', unit: '', min: 0.1, max: 1, description: '하류 압력과 외기 온도의 상관계수 절댓값이 이 값 이상이면 온도 체크를 지지로 봅니다.' }),
  setpointChangeBar: numParam(D.setpointChangeBar, { label: '설정값 변경 기준', unit: 'bar', min: 0.001, max: 10, description: '기준·최근 구간 설정 압력 차이가 이 값을 넘으면 설정값 재조정 체크를 지지로 봅니다.' }),
  resolutionSigmaFactor: numParam(D.resolutionSigmaFactor, { label: '계측 분해능 배수', unit: '배', min: 0.5, max: 20, description: '하류 압력 잡음(σ)이 크리프율 × 이 배수보다 크면 계기 스팬이 너무 넓다고 봅니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'prv.seat_leak', version: '1', failureMode: 'prv.seat_leak', category: 'degradation' } as const;

/** 수소 표준상태 밀도 [kg/Nm³] (0 °C·101.325 kPa) — 크리프율을 NL/min으로 환산할 때 쓴다 */
const H2_KG_PER_NM3 = 0.08988;

export interface HoldFit {
  readonly start: number;
  readonly end: number;
  readonly hours: number;
  /** Theil–Sen 기울기 [bar/h] */
  readonly creepBarPerH: number;
  /** 구간 후반 기울기 ÷ 전반 기울기 (안정되면 작아진다 = 공급압 효과) */
  readonly settleRatio: number | null;
  readonly startBar: number;
  readonly endBar: number;
  /** 회귀 잔차 σ [bar] (MAD → σ) */
  readonly sigmaBar: number;
  readonly supplyR: number | null;
  readonly temperatureR: number | null;
  readonly setpointBar: number | null;
}

const slopeOf = (hours: readonly PrvHoldHour[]): number => theilSen(hours.map((h) => h.hourStart / 3_600_000), hours.map((h) => h.outletBar)).slope;

function fitHold(hold: PrvHold): HoldFit | null {
  const hours = hold.hours;
  const first = hours[0];
  const last = hours.at(-1);
  if (!first || !last || hours.length < 3) return null;
  const xs = hours.map((h) => h.hourStart / 3_600_000);
  const fit = theilSen(xs, hours.map((h) => h.outletBar));
  const residuals = hours.map((h, i) => h.outletBar - (fit.intercept + fit.slope * (xs[i] as number)));
  const half = Math.floor(hours.length / 2);
  const early = hours.slice(0, half + 1);
  const late = hours.slice(half);
  const earlySlope = early.length >= 2 ? slopeOf(early) : null;
  const lateSlope = late.length >= 2 ? slopeOf(late) : null;
  const inlet = hours.flatMap((h) => (h.inletBar === null ? [] : [h]));
  const ambient = hours.flatMap((h) => (h.ambientC === null ? [] : [h]));
  return {
    start: hold.start,
    end: hold.end,
    hours: hours.length,
    creepBarPerH: fit.slope,
    settleRatio: earlySlope !== null && lateSlope !== null && Math.abs(earlySlope) > 1e-9 ? lateSlope / earlySlope : null,
    startBar: first.outletBar,
    endBar: last.outletBar,
    sigmaBar: MAD_TO_SIGMA * mad(residuals),
    supplyR: inlet.length >= 3 ? pearson(inlet.map((h) => h.inletBar as number), inlet.map((h) => h.outletBar)) : null,
    temperatureR: ambient.length >= 3 ? pearson(ambient.map((h) => h.ambientC as number), ambient.map((h) => h.outletBar)) : null,
    setpointBar: medianOrNull(hours.flatMap((h) => (h.setpointBar === null ? [] : [h.setpointBar]))),
  };
}

interface Split {
  readonly all: readonly HoldFit[];
  readonly reference: readonly HoldFit[];
  readonly recent: readonly HoldFit[];
}

function splitHolds(input: PrvSeatLeakInput, ctx: DetectorContext<PrvSeatLeakParams>, p: PrvSeatLeakParams): Split {
  const from = ctx.baselineResetAt ?? -Infinity;
  const all = input.holds
    .filter((h) => h.hours.length >= p.minHoldHours && h.start >= from && h.end <= ctx.now)
    .map(fitHold)
    .filter((f): f is HoldFit => f !== null)
    .sort((a, b) => a.start - b.start);
  const recentFrom = ctx.now - p.recentDays * MS_PER_DAY;
  const recent = all.filter((f) => f.start >= recentFrom).slice(-p.recentHolds);
  const firstRecent = recent[0]?.start ?? Infinity;
  const reference = all.filter((f) => f.start < firstRecent).slice(-p.referenceHolds);
  return { all, reference, recent };
}

function checksOf(input: PrvSeatLeakInput, split: Split, p: PrvSeatLeakParams): DiagnosticCheck[] {
  const { recent, reference } = split;
  const supplyR = medianOrNull(recent.flatMap((f) => (f.supplyR === null ? [] : [-f.supplyR])));
  const settle = medianOrNull(recent.flatMap((f) => (f.settleRatio === null ? [] : [f.settleRatio])));
  // 공급압 효과: 하류 압력이 상류 압력과 함께 움직이거나, 구간 후반 기울기가 전반의 1/3 이하로 잦아든다
  const supplyLevel = supplyR === null && settle === null ? null : Math.max(supplyR ?? 0, settle !== null && settle <= 1 / 3 ? 1 : 0);
  const supply = levelCheck('supply_pressure', '공급압 효과 (상류 압력이 떨어질 때 설정압이 오르는 현상)', supplyLevel, [p.supplyCorrelationR, 0.3], { median_inverse_r: r(supplyR, 3), settle_ratio: r(settle, 3) }, {
    supports: '하류 압력이 상류 압력과 함께 움직이거나 구간 후반에 잦아듭니다. 시트 누설이 아니라 공급압 효과(EN 334 AC·SG 등급)일 수 있습니다.',
    refutes: '하류 압력 상승은 상류 압력과 무관하고 구간 내내 이어집니다.',
    unknown: '공급압과의 관계가 약하게 있습니다.',
    no_data: '상류 압력·구간 분할 데이터가 부족해 공급압 효과를 가릴 수 없습니다.',
  });

  const tempR = medianOrNull(recent.flatMap((f) => (f.temperatureR === null ? [] : [Math.abs(f.temperatureR)])));
  const temperature = levelCheck('temperature', '온도 상승에 따른 압력 상승', tempR, [p.temperatureCorrelationR, 0.3], { median_abs_r: r(tempR, 3) }, {
    supports: '하류 압력이 외기 온도와 함께 움직입니다. 밀폐 체적의 열팽창일 수 있습니다.',
    refutes: '하류 압력 상승은 외기 온도와 관계가 약합니다.',
    unknown: '온도와 약한 관계가 있습니다.',
    no_data: '외기 온도 데이터가 없습니다.',
  });

  const refSet = medianOrNull(reference.flatMap((f) => (f.setpointBar === null ? [] : [f.setpointBar])));
  const curSet = medianOrNull(recent.flatMap((f) => (f.setpointBar === null ? [] : [f.setpointBar])));
  const setpointShift = refSet === null || curSet === null ? null : Math.abs(curSet - refSet);
  const setpoint = levelCheck('setpoint_change', '설정 압력 재조정', setpointShift, [p.setpointChangeBar, p.setpointChangeBar / 4], { ref_bar: r(refSet, 4), recent_bar: r(curSet, 4) }, {
    supports: '설정 압력이 바뀌었습니다. 현장 재조정 이력을 확인하고 기준선을 다시 잡으세요.',
    refutes: '설정 압력은 그대로입니다.',
    unknown: '설정 압력이 조금 달라졌습니다.',
    no_data: '설정 압력 포인트가 없습니다 (h2.pressure.setpoint 확보 권고).',
  });

  const creep = medianOrNull(recent.map((f) => f.creepBarPerH)) ?? 0;
  const sigma = medianOrNull(recent.map((f) => f.sigmaBar));
  const resolution = levelCheck('measurement_resolution', '계측 분해능 (하류 압력계 스팬)', sigma === null || creep <= 0 ? null : sigma / (creep * p.resolutionSigmaFactor), [1, 0.5], { sigma_bar: r(sigma, 4), creep_bar_per_h: r(creep, 5) }, {
    supports: '하류 압력 잡음이 크리프율에 비해 큽니다. 넓은 스팬 전송기로는 mbar급 크리프를 원리상 가릴 수 없습니다 — 스팬 재지정을 검토하세요.',
    refutes: '하류 압력 잡음이 크리프율보다 충분히 작습니다.',
    unknown: '하류 압력 잡음이 크리프율과 비슷한 수준입니다.',
    no_data: '하류 압력 잡음을 계산할 수 없습니다.',
  });

  const short = recent.filter((f) => f.hours < p.minHoldHours + 1).length;
  const holdLength = makeCheck('hold_length', 'hold 구간 길이', short === 0 ? 'refutes' : short >= recent.length / 2 ? 'supports' : 'unknown', { short_holds: short, holds: recent.length, min_hours: p.minHoldHours }, short === 0 ? '최근 hold가 모두 충분히 깁니다.' : '짧은 hold가 섞여 있어 기울기 불확실성이 큽니다. 긴 정지 구간으로 다시 확인하세요.');
  return [supply, temperature, setpoint, resolution, holdLength];
}

/** 크리프율 [bar/h] → 누설 유량 [NL/min] (하류 밀폐 체적 기준, 등온 이상기체 근사) */
export function creepToNlPerMin(creepBarPerH: number, volumeM3: number): number {
  const kgPerH = (creepBarPerH * 1e5 * volumeM3) / (4124.4829 * 293.15);
  return (kgPerH / H2_KG_PER_NM3 / 60) * 1000;
}

function buildFinding(input: PrvSeatLeakInput, ctx: DetectorContext<PrvSeatLeakParams>, p: PrvSeatLeakParams, split: Split): CandidateFinding | null {
  const { recent, reference } = split;
  const creeps = recent.map((f) => f.creepBarPerH);
  const creep = median(creeps);
  const alarmHolds = recent.filter((f) => f.creepBarPerH > p.creepBarPerH).length;
  if (!(creep > p.creepBarPerH) || alarmHolds < p.minAlarmHolds) return null;
  const severity: Severity = severityByMagnitude(creep, [[p.severeCreepBarPerH, 3], [p.creepBarPerH, 2]]) ?? 2;
  const ci = bootstrapCI(creeps, median, { iterations: p.iterations, rng: ctx.rng });
  const checks = checksOf(input, split, p);
  const supported = checks.filter((c) => c.status === 'supports').map((c) => c.label);
  const referenceCreep = medianOrNull(reference.map((f) => f.creepBarPerH));
  const nlPerMin = input.downstreamVolumeM3 === null ? null : creepToNlPerMin(creep, input.downstreamVolumeM3);
  const evidence: JsonObject = {
    method: 'hold_theil_sen_median',
    sign_convention: '크리프율 = 무유동 구간 하류 압력의 Theil–Sen 기울기 (양수 = 시트로 가스가 새어 하류가 올라감)',
    threshold: { warn_bar_per_h: p.creepBarPerH, alert_bar_per_h: p.severeCreepBarPerH, min_alarm_holds: p.minAlarmHolds, alarm_holds: alarmHolds },
    setpoint_bar: r(input.outletSetBar, 4),
    downstream_volume_m3: r(input.downstreamVolumeM3, 4),
    leak_nl_per_min: r(nlPerMin, 4),
    reference: { holds: reference.length, median_bar_per_h: r(referenceCreep, 5) },
    recent: { holds: recent.length, median_bar_per_h: r(creep, 5), ci_low: r(ci.ciLow, 5), ci_high: r(ci.ciHigh, 5) },
    holds: downsample(recent.map((f) => ({ start: f.start, date: kstDateString(f.start), hours: f.hours, creep_bar_per_h: r(f.creepBarPerH, 5), start_bar: r(f.startBar, 4), end_bar: r(f.endBar, 4), settle_ratio: r(f.settleRatio, 3) })), 120),
    checks,
    note: `무유동 구간 판정입니다. 운전 정지·안전밸브 점검 여부는 현장 안전책임자가 정합니다. ${SAFETY_DISCLAIMER}`,
  };
  return {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: META.category,
    severity,
    confidence: scoreConfidence({ n: recent.length, ciWidth: relativeCiWidth(creep, ci.ciLow, ci.ciHigh), dqCompleteness: 1, methodsAgree: checks.find((c) => c.id === 'supply_pressure')?.status === 'refutes' }),
    title: `감압밸브 하류 압력 크리프 ${fixed(creep * 1000, 0)} mbar/h`,
    summary:
      `연료전지 정지(무유동) 구간 ${recent.length}개 중 ${alarmHolds}개에서 하류 압력이 올랐습니다. 크리프율 중앙값 ${fixed(creep * 1000, 0)} mbar/h(95% CI ${fixed(ci.ciLow * 1000, 0)} ~ ${fixed(ci.ciHigh * 1000, 0)}, 기준 ${fixed(p.creepBarPerH * 1000, 0)} mbar/h)` +
      `${nlPerMin === null ? '' : `, 하류 체적 ${fixed(input.downstreamVolumeM3 ?? 0, 2)} m³ 기준 약 ${fixed(nlPerMin, 2)} NL/min`}${referenceCreep === null ? '' : `, 기준 구간 ${fixed(referenceCreep * 1000, 0)} mbar/h`}.` +
      (supported.length > 0 ? ` 함께 확인된 신호: ${supported.join(', ')}.` : ''),
    effect: { metric: 'prv_creep_mbar_per_h', value: r(creep * 1000, 3) ?? 0, unit: 'mbar/h', ciLow: r(ci.ciLow * 1000, 3), ciHigh: r(ci.ciHigh * 1000, 3), baseline: r(referenceCreep === null ? null : referenceCreep * 1000, 3), current: r(creep * 1000, 3), levelUnit: 'mbar/h' },
    windowStart: reference[0]?.start ?? recent[0]?.start ?? ctx.now,
    windowEnd: recent.at(-1)?.end ?? ctx.now,
    evidence,
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, recent: recent.map((f) => [f.start, r(f.creepBarPerH, 6)]), reference: reference.map((f) => [f.start, r(f.creepBarPerH, 6)]) }),
  };
}

function detect(input: PrvSeatLeakInput, ctx: DetectorContext<PrvSeatLeakParams>): DetectorResult {
  const p = withDefaults(PRV_SEAT_LEAK_DEFAULTS, ctx.params);
  const split = splitHolds(input, ctx, p);
  if (split.recent.length < p.minAlarmHolds) {
    return insufficient(`무유동 hold 구간 부족: 최근 ${p.recentDays}일에 ${split.recent.length}개 (${p.minHoldHours}시간 이상 hold가 ${p.minAlarmHolds}개 필요)`);
  }
  const finding = buildFinding(input, ctx, p, split);
  return { status: 'ok', findings: finding ? [finding] : [] };
}

export const prvSeatLeak: Detector<PrvSeatLeakInput, PrvSeatLeakParams> = {
  ...META,
  requires: {
    assetClass: ['h2.prv'],
    metrics: [
      required('h2.pressure', SLOW_S), // 감압밸브 하류 압력 (한정자 fc.inlet). 크리프 판정의 본체
      required('fc.h2.consumption', SLOW_S), // 무유동 구간 판정 (연료전지 정지)
      recommended('h2.pressure.setpoint', SLOW_S), // 판별 체크 ③ 설정값 재조정
      recommended('ambient.temp', SLOW_S), // 판별 체크 ② 온도 상승
    ],
    minHistoryDays: 21,
  },
  defaultParams: PRV_SEAT_LEAK_DEFAULTS,
  paramSchema: PRV_SEAT_LEAK_PARAM_SCHEMA,
  detect,
};
