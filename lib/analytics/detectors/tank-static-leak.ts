// tank.static_leak@1 — 수소 저장용기 정지 보유 구간 누설.
// 1) 정지 보유 구간(tank.hold, 유입·유출 없음) ≥ minStaticHours마다 압력·온도 → Abel–Noble 실기체 밀도 × 내용적 = 온도 보정 질량.
// 2) 구간별 질량의 Theil–Sen 기울기 → 손실률 kg/일 + Sen 95% CI.
// 3) 최근 N개 구간을 가중 중앙값(가중치 = 1 / CI 반폭²)으로 결합 → 누설률, 구간 재표집 부트스트랩 CI.
// 4) 기준 창(가장 이른 referenceHolds개 또는 detector_config 기준 창)의 구간 손실률 산포 = 센서 잡음 수준 σ.
//    유의 = 결합 누설률 > zSigma × σ / √n 이고 CI 하한 > 0.
// 5) safety(severity 4)는 누설률 CI 하한 > safetyKgPerDay일 때만. 유의하지만 그 미만이면 performance severity 3 "미세 누설 의심 — 현장 점검 권고".
// 판별 체크: ① 온도 보정 잔차(구간 손실률이 온도 변화율과 상관 → 보정 부족·열 지연) ② 압력 센서 드리프트(같은 뱅크 다른 용기·압축기 토출 압력과의 차이 추세)
//           ③ 밸브 통과 누설(하류 압력 상승 동반) ④ 구간 수·길이 충분성.
// 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않는다 — 운전 정지 판단은 현장 안전책임자 몫이다.
import * as z from 'zod';
import type { TankHoldPoint } from '../episodes/tank-hold';
import { downsample } from '../episodes/series';
import { hashInput } from '../hash';
import { bootstrapCI } from '../stats/bootstrap';
import { relativeCiWidth, scoreConfidence } from '../stats/confidence';
import { MAD_TO_SIGMA, mad, median, weightedMedian } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '../types';
import { fixed, insufficient, r, withDefaults } from './common';
import { ABEL_NOBLE_DEFAULTS, h2MassKg, type AbelNobleConstants } from './hydrogen-eos';
import { completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import { holdEvidence, tankChecks, type HoldFit } from './tank-static-leak-checks';
import type { CandidateFinding, Detector, DetectorContext, DetectorResult } from './types';

/** 정지 보유 구간 하나 (tank.hold 에피소드 + 구간 안 압력·온도 짝) */
export interface TankHoldInput {
  readonly start: number;
  readonly end: number;
  readonly completeness: number;
  readonly points: readonly TankHoldPoint[];
  /** 하류(연료전지 공급) 압력 끝 − 시작 [bar]. 모르면 null */
  readonly downstreamRiseBar: number | null;
}

/** 압력 교차 확인: 이 용기 압력 − 비교 압력 (같은 뱅크 다른 용기 중앙값·충전 직후 압축기 토출 압력) */
export interface PressureCrossCheck {
  readonly ts: number;
  readonly offsetBar: number;
  readonly source: 'peer_tank' | 'compressor_discharge';
}

export interface TankStaticLeakInput {
  readonly assetId: number;
  /** 명판 내용적 [L] */
  readonly waterVolumeL: number;
  readonly holds: readonly TankHoldInput[];
  readonly pressureCrossChecks?: readonly PressureCrossCheck[];
}

export interface TankStaticLeakParams {
  readonly minStaticHours: number;
  readonly minPoints: number;
  readonly minCompleteness: number;
  readonly referenceHolds: number;
  readonly minReferenceHolds: number;
  readonly recentHolds: number;
  readonly minRecentHolds: number;
  readonly recentDays: number;
  readonly zSigma: number;
  readonly noiseFloorKgPerDay: number;
  readonly safetyKgPerDay: number;
  readonly specificGasConstant: number;
  readonly coVolume: number;
  readonly tempCorrelationR: number;
  readonly downstreamRiseBar: number;
  readonly iterations: number;
}

export const TANK_STATIC_LEAK_DEFAULTS: TankStaticLeakParams = Object.freeze({
  minStaticHours: 4,
  minPoints: 12,
  minCompleteness: 0.8,
  referenceHolds: 6,
  minReferenceHolds: 4,
  recentHolds: 6,
  minRecentHolds: 4,
  recentDays: 30,
  zSigma: 3,
  noiseFloorKgPerDay: 0.02,
  safetyKgPerDay: 0.5,
  specificGasConstant: ABEL_NOBLE_DEFAULTS.specificGasConstant,
  coVolume: ABEL_NOBLE_DEFAULTS.coVolume,
  tempCorrelationR: 0.6,
  downstreamRiseBar: 1,
  iterations: 1000,
});

const D = TANK_STATIC_LEAK_DEFAULTS;
export const TANK_STATIC_LEAK_PARAM_SCHEMA = z.object({
  minStaticHours: numParam(D.minStaticHours, { label: '최소 정지 보유 시간', unit: 'h', min: 1, max: 72, description: '유입·유출이 없는 구간이 이 시간 이상인 것만 누설률 계산에 씁니다.' }),
  minPoints: intParam(D.minPoints, { label: '구간 최소 샘플 수', unit: '개', min: 5, max: 10_000, description: '압력·온도 짝이 이보다 적은 구간은 뺍니다.' }),
  minCompleteness: completenessParam(D.minCompleteness),
  referenceHolds: intParam(D.referenceHolds, { label: '기준 구간 수', unit: '개', min: 3, max: 100, description: '기준 창이 없을 때 가장 이른 이 수만큼의 구간으로 센서 잡음 수준을 잽니다.' }),
  minReferenceHolds: intParam(D.minReferenceHolds, { label: '최소 기준 구간 수', unit: '개', min: 2, max: 100, description: '기준 구간이 이보다 적으면 판정 불능입니다.' }),
  recentHolds: intParam(D.recentHolds, { label: '최근 결합 구간 수', unit: '개', min: 2, max: 100, description: '최근 기간의 마지막 이 수만큼 구간을 결합해 누설률을 냅니다.' }),
  minRecentHolds: intParam(D.minRecentHolds, { label: '최소 최근 구간 수', unit: '개', min: 2, max: 100, description: '최근 구간이 이보다 적으면 판정 불능입니다.' }),
  recentDays: intParam(D.recentDays, { label: '최근 기간', unit: '일', min: 3, max: 180, description: '최근 구간을 고르는 기간입니다.' }),
  zSigma: numParam(D.zSigma, { label: '유의 배수', unit: 'σ', min: 1, max: 10, description: '결합 누설률이 (이 배수 × 센서 잡음 σ ÷ √구간 수)를 넘어야 유의로 봅니다.' }),
  noiseFloorKgPerDay: numParam(D.noiseFloorKgPerDay, { label: '잡음 σ 하한', unit: 'kg/일', min: 0.0001, max: 10, description: '기준 구간 손실률 산포가 이보다 작아도 이 값을 잡음 σ로 씁니다.' }),
  safetyKgPerDay: numParam(D.safetyKgPerDay, { label: '안전 카테고리 누설률', unit: 'kg/일', min: 0.001, max: 100, description: '누설률 95% CI 하한이 이 값을 넘을 때만 safety(severity 4)로 올립니다. 추정 초기값이며 현장 기준으로 조정하세요.' }),
  specificGasConstant: numParam(D.specificGasConstant, { label: '수소 비기체상수 R_s', unit: 'J/(kg·K)', min: 4000, max: 4300, description: 'Abel–Noble 상태식 ρ = P/(R_s·T + b·P)의 R_s입니다.' }),
  coVolume: numParam(D.coVolume, { label: 'Abel–Noble 공부피 b', unit: 'm³/kg', min: 0, max: 0.02, description: 'Abel–Noble 상태식의 공부피 b입니다. 0이면 이상기체입니다.' }),
  tempCorrelationR: numParam(D.tempCorrelationR, { label: '온도 상관 기준', unit: '', min: 0.1, max: 1, description: '구간 손실률과 온도 변화율 상관계수 절댓값이 이 값 이상이면 온도 보정 부족 체크를 지지로 봅니다.' }),
  downstreamRiseBar: numParam(D.downstreamRiseBar, { label: '하류 압력 상승 기준', unit: 'bar', min: 0.01, max: 100, description: '정지 구간 동안 하류 압력이 이만큼 오르면 밸브 통과 누설로 셉니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'tank.static_leak', version: '1', failureMode: 'h2.storage_leak', category: 'safety' } as const;

/** 구간 하나 → 온도 보정 질량 Theil–Sen 기울기. 요건 미달이면 null */
export function fitHold(hold: TankHoldInput, volumeM3: number, constants: AbelNobleConstants, p: Pick<TankStaticLeakParams, 'minStaticHours' | 'minPoints' | 'minCompleteness'>): HoldFit | null {
  const hours = (hold.end - hold.start) / MS_PER_HOUR;
  const points = downsample(hold.points, 240);
  if (hours < p.minStaticHours || hold.completeness < p.minCompleteness || points.length < p.minPoints) return null;
  const xs = points.map((pt) => (pt.ts - hold.start) / MS_PER_DAY);
  if (new Set(xs).size < 3) return null;
  const masses = points.map((pt) => h2MassKg(pt.pressureBar, pt.tempC, volumeM3, constants));
  const tXs = points.map((pt) => pt.tempC);
  const massFit = theilSen(xs, masses);
  const tempFit = theilSen(xs, tXs);
  return {
    hold,
    hours,
    lossKgPerDay: -massFit.slope,
    ciLowKgPerDay: -massFit.ciHigh,
    ciHighKgPerDay: -massFit.ciLow,
    tempRateCPerDay: tempFit.slope,
    tempMeanC: median(tXs),
    pressureMeanBar: median(points.map((pt) => pt.pressureBar)),
    massMeanKg: median(masses),
  };
}

/** 가중치 1/반폭²가 한 구간에 쏠리지 않도록 반폭 하한 1 g/일 */
const halfWidth = (fit: HoldFit): number => Math.max((fit.ciHighKgPerDay - fit.ciLowKgPerDay) / 2, 1e-3);
const combine = (fits: readonly HoldFit[]): number => weightedMedian(fits.map((f) => f.lossKgPerDay), fits.map((f) => 1 / halfWidth(f) ** 2));

interface Split {
  readonly reference: readonly HoldFit[];
  readonly recent: readonly HoldFit[];
}

/** 구간 길이·완결성·점 수를 먼저 거르고 기준·최근 구간만 기울기를 구한다 (긴 이력에서 모든 구간을 적합하지 않도록) */
function splitHolds(holds: readonly TankHoldInput[], ctx: DetectorContext<TankStaticLeakParams>, p: TankStaticLeakParams, fit: (hold: TankHoldInput) => HoldFit | null): Split {
  const from = ctx.baselineResetAt ?? -Infinity;
  const eligible = [...holds]
    .filter((h) => h.start >= from && h.end <= ctx.now && (h.end - h.start) / MS_PER_HOUR >= p.minStaticHours && h.completeness >= p.minCompleteness && h.points.length >= p.minPoints)
    .sort((a, b) => a.start - b.start);
  const window: TimeWindow | undefined = ctx.referenceWindow;
  const referenceHolds = window ? eligible.filter((h) => h.start >= window.start && h.start < window.end) : eligible.slice(0, p.referenceHolds);
  const referenceEnd = referenceHolds.at(-1)?.end ?? Infinity;
  const recentHolds = eligible.filter((h) => h.start >= referenceEnd && h.start >= ctx.now - p.recentDays * MS_PER_DAY).slice(-p.recentHolds);
  const fitAll = (items: readonly TankHoldInput[]) => items.flatMap((h) => fit(h) ?? []);
  return { reference: fitAll(referenceHolds), recent: fitAll(recentHolds) };
}

function detect(input: TankStaticLeakInput, ctx: DetectorContext<TankStaticLeakParams>): DetectorResult {
  const p = withDefaults(TANK_STATIC_LEAK_DEFAULTS, ctx.params);
  if (!(input.waterVolumeL > 0)) return insufficient('저장용기 내용적(명판 water_volume_l)이 없습니다');
  const volumeM3 = input.waterVolumeL / 1000;
  const constants = { specificGasConstant: p.specificGasConstant, coVolume: p.coVolume };
  const { reference, recent } = splitHolds(input.holds, ctx, p, (hold) => fitHold(hold, volumeM3, constants, p));
  if (reference.length < p.minReferenceHolds || recent.length < p.minRecentHolds) {
    return insufficient(`정지 보유 구간 부족: 기준 ${reference.length}개·최근 ${recent.length}개 (각 ${p.minReferenceHolds}·${p.minRecentHolds}개 필요, ${fixed(p.minStaticHours, 0)} h 이상·완결성 ${fixed(p.minCompleteness * 100, 0)}% 이상)`);
  }
  const leak = combine(recent);
  const ci = bootstrapCI(recent, combine, { iterations: p.iterations, rng: ctx.rng });
  const referenceLosses = reference.map((f) => f.lossKgPerDay);
  const noise = Math.max(MAD_TO_SIGMA * mad(referenceLosses), p.noiseFloorKgPerDay);
  const threshold = (p.zSigma * noise) / Math.sqrt(recent.length);
  if (!(leak > threshold && ci.ciLow > 0)) return { status: 'ok', findings: [] };

  const safety = ci.ciLow > p.safetyKgPerDay;
  const checks = tankChecks({ fits: [...reference, ...recent], recent, leak, volumeM3, constants, crossChecks: input.pressureCrossChecks, p });
  const massMean = median(recent.map((f) => f.massMeanKg));
  const pctPerDay = massMean > 0 ? (leak / massMean) * 100 : null;
  const finding: CandidateFinding = {
    detectorId: META.id,
    detectorVersion: META.version,
    assetId: input.assetId,
    failureMode: META.failureMode,
    category: safety ? 'safety' : 'performance',
    severity: safety ? 4 : 3,
    confidence: scoreConfidence({ n: recent.length, ciWidth: relativeCiWidth(leak, ci.ciLow, ci.ciHigh), dqCompleteness: median(recent.map((f) => f.hold.completeness)), methodsAgree: recent.filter((f) => f.ciLowKgPerDay > 0).length >= Math.ceil(recent.length / 2) }),
    title: safety ? `저장용기 누설 의심 ${fixed(leak, 2)} kg/일 — 즉시 현장 확인` : `미세 누설 의심 ${fixed(leak, 3)} kg/일 — 현장 점검 권고`,
    summary:
      `정지 보유 구간 ${recent.length}개(각 ${fixed(p.minStaticHours, 0)} h 이상)의 온도 보정 질량(Abel–Noble)이 하루 ${fixed(leak, 3)} kg(95% CI ${fixed(ci.ciLow, 3)} ~ ${fixed(ci.ciHigh, 3)} kg${pctPerDay === null ? '' : `, 저장량의 ${fixed(pctPerDay, 2)}%`}) 줄었습니다. ` +
      `기준 구간 ${reference.length}개의 센서 잡음 수준(σ ${fixed(noise, 3)} kg/일) 대비 유의합니다. ` +
      (safety ? `누설률 CI 하한이 안전 기준 ${fixed(p.safetyKgPerDay, 2)} kg/일을 넘습니다. 가스 검지기 확인과 누설 점검을 즉시 진행하고, 운전 정지 여부는 현장 안전책임자가 판단하세요.` : '가스 검지기 기록 확인과 휴대용 검지기·발포액 누설 점검을 권고합니다.') +
      ' 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.',
    effect: { metric: 'tank_leak_kg_per_day', value: r(leak, 4) ?? 0, unit: 'kg/일', ciLow: r(ci.ciLow, 4), ciHigh: r(ci.ciHigh, 4), baseline: r(median(referenceLosses), 4), current: r(leak, 4), levelUnit: 'kg/일' },
    windowStart: reference[0]?.hold.start ?? ctx.now,
    windowEnd: recent.at(-1)?.hold.end ?? ctx.now,
    evidence: holdEvidence({ reference, recent, leak, ci, noise, threshold, pctPerDay, safety, checks, constants, volumeM3, p }),
    inputHash: hashInput({ detector: `${META.id}@${META.version}`, params: p, volume: input.waterVolumeL, holds: [...reference, ...recent].map((f) => [f.hold.start, f.hold.end, f.hold.points.map((pt) => [pt.ts, pt.pressureBar, pt.tempC])]), cross: input.pressureCrossChecks ?? null }),
  };
  return { status: 'ok', findings: [finding] };
}

export const tankStaticLeak: Detector<TankStaticLeakInput, TankStaticLeakParams> = {
  ...META,
  requires: { assetClass: ['h2.storage.tank'], metrics: ['tank.pressure', 'tank.temp', 'valve.open', 'compressor.power', 'fc.h2.consumption'], minPeriodS: 300, minHistoryDays: 14 },
  defaultParams: TANK_STATIC_LEAK_DEFAULTS,
  paramSchema: TANK_STATIC_LEAK_PARAM_SCHEMA,
  detect,
};
