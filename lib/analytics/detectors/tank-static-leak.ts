// tank.static_leak@1 — 수소 저장용기 정지 보유 구간 누설.
// 1) 정지 보유 구간(tank.hold, 유입·유출 없음) ≥ minStaticHours마다 압력·온도 → 실기체 밀도(기본 NIST Lemmon 2008) × 내용적 = 온도 보정 질량.
// 2) 구간별 질량의 Theil–Sen 기울기 → 손실률 kg/일 + Sen 95% CI.
// 3) 최근 N개 구간을 가중 중앙값(가중치 = 1 / CI 반폭²)으로 결합 → 누설률.
// 4) 기준 창(가장 이른 referenceHolds개 또는 detector_config 기준 창)의 구간 손실률 산포(MAD, 구간 안 기울기 불확실도 중앙값을 하한) = 센서 잡음 수준 σ,
//    기준 구간 손실률 중앙값 = 겉보기 손실 편향(상태식·야간 냉각 온도 보정 오차). 편향은 ±maxBaselineSigma × √(π/2)·σ/√기준 구간 수 안에서만 뺀다
//    (준공 때부터 새던 용기의 누설을 기준으로 지우지 않도록 한도를 둔다).
//    판정값 = 최근 가중 중앙값 − 기준 중앙값이므로 표준오차 SE = √(π/2)·σ·√(1/n_eff최근 + 1/n기준) (leakStandardError 주석에 유도).
//    유의 = 판정값 > zSigma × SE 이고 CI 하한 > 0. CI 반폭 = max(1.96 × SE, 최근 구간 부트스트랩 반폭).
// 5) safety(severity 4)는 누설률 CI 하한 > safetyKgPerDay일 때만. 유의하지만 그 미만이면 performance severity 3 "미세 누설 의심 — 현장 점검 권고".
// 판별 체크: ① 온도 보정 잔차(구간 손실률이 온도 변화율과 상관 → 보정 부족·열 지연) ② 뱅크 교차 확인(같은 구간 다른 용기·압축기 토출 압력 기울기 대비)
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
import { ABEL_NOBLE_DEFAULTS, h2Eos, H2_EOS_MODELS, type H2Eos, type H2EosModel } from './hydrogen-eos';
import { choiceParam, completenessParam, intParam, iterationsParam, numParam } from './param-schema';
import type { PressureCrossCheck } from './tank-peer-pressure';
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
  readonly maxBaselineSigma: number;
  readonly noiseFloorKgPerDay: number;
  readonly safetyKgPerDay: number;
  readonly eosModel: H2EosModel;
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
  referenceHolds: 12,
  minReferenceHolds: 6,
  recentHolds: 6,
  minRecentHolds: 4,
  recentDays: 30,
  zSigma: 3,
  maxBaselineSigma: 3,
  noiseFloorKgPerDay: 0.02,
  safetyKgPerDay: 0.5,
  eosModel: 'lemmon2008',
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
  zSigma: numParam(D.zSigma, { label: '유의 배수', unit: 'σ', min: 1, max: 10, description: '결합 누설률이 (이 배수 × 표준오차 SE)를 넘어야 유의로 봅니다. SE = √(π/2)·σ·√(1/유효 최근 구간 수 + 1/기준 구간 수).' }),
  maxBaselineSigma: numParam(D.maxBaselineSigma, { label: '기준 편향 보정 한도', unit: 'σ', min: 0, max: 10, description: '기준 구간 겉보기 손실률(상태식·온도 보정 편향)을 (이 배수 × √(π/2)·σ ÷ √기준 구간 수) 안에서만 빼고 누설률을 냅니다. 0이면 보정하지 않습니다.' }),
  noiseFloorKgPerDay: numParam(D.noiseFloorKgPerDay, { label: '잡음 σ 하한', unit: 'kg/일', min: 0.0001, max: 10, description: '기준 구간 손실률 산포가 이보다 작아도 이 값을 잡음 σ로 씁니다.' }),
  safetyKgPerDay: numParam(D.safetyKgPerDay, { label: '안전 카테고리 누설률', unit: 'kg/일', min: 0.001, max: 100, description: '누설률 95% CI 하한이 이 값을 넘을 때만 safety(severity 4)로 올립니다. 추정 초기값이며 현장 기준으로 조정하세요.' }),
  eosModel: choiceParam(H2_EOS_MODELS, D.eosModel, { label: '수소 상태식', description: 'lemmon2008 = NIST 수소 계량용 표준 밀도식(기본), abel_noble = ρ = P/(R_s·T + b·P) 근사식입니다.' }),
  specificGasConstant: numParam(D.specificGasConstant, { label: '수소 비기체상수 R_s', unit: 'J/(kg·K)', min: 4000, max: 4300, description: '상태식이 abel_noble일 때 ρ = P/(R_s·T + b·P)의 R_s입니다.' }),
  coVolume: numParam(D.coVolume, { label: 'Abel–Noble 공부피 b', unit: 'm³/kg', min: 0, max: 0.02, description: '상태식이 abel_noble일 때 공부피 b입니다. 0이면 이상기체입니다.' }),
  tempCorrelationR: numParam(D.tempCorrelationR, { label: '온도 상관 기준', unit: '', min: 0.1, max: 1, description: '구간 손실률과 온도 변화율 상관계수 절댓값이 이 값 이상이면 온도 보정 부족 체크를 지지로 봅니다.' }),
  downstreamRiseBar: numParam(D.downstreamRiseBar, { label: '하류 압력 상승 기준', unit: 'bar', min: 0.01, max: 100, description: '정지 구간 동안 하류 압력이 이만큼 오르면 밸브 통과 누설로 셉니다.' }),
  iterations: iterationsParam(D.iterations),
});

const META = { id: 'tank.static_leak', version: '1', failureMode: 'h2.storage_leak', category: 'safety' } as const;

/** 구간 하나 → 온도 보정 질량 Theil–Sen 기울기. 요건 미달이면 null */
export function fitHold(hold: TankHoldInput, volumeM3: number, eos: H2Eos, p: Pick<TankStaticLeakParams, 'minStaticHours' | 'minPoints' | 'minCompleteness'>): HoldFit | null {
  const hours = (hold.end - hold.start) / MS_PER_HOUR;
  const points = downsample(hold.points, 240);
  if (hours < p.minStaticHours || hold.completeness < p.minCompleteness || points.length < p.minPoints) return null;
  const xs = points.map((pt) => (pt.ts - hold.start) / MS_PER_DAY);
  if (new Set(xs).size < 3) return null;
  const masses = points.map((pt) => eos.mass(pt.pressureBar, pt.tempC, volumeM3));
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
    pressureRateBarPerDay: theilSen(xs, points.map((pt) => pt.pressureBar)).slope,
    tempMeanC: median(tXs),
    pressureMeanBar: median(points.map((pt) => pt.pressureBar)),
    massMeanKg: median(masses),
  };
}

/** 가중치 1/반폭²가 한 구간에 쏠리지 않도록 반폭 하한 1 g/일 */
const halfWidth = (fit: HoldFit): number => Math.max((fit.ciHighKgPerDay - fit.ciLowKgPerDay) / 2, 1e-3);
const weightOf = (fit: HoldFit): number => 1 / halfWidth(fit) ** 2;
const combine = (fits: readonly HoldFit[]): number => weightedMedian(fits.map((f) => f.lossKgPerDay), fits.map(weightOf));

/**
 * 정규 표본에서 중앙값의 점근 표준오차 계수 √(π/2) ≈ 1.2533 (평균 대비 비효율).
 * Var(median) → (π/4)·σ²/n × 2 = (π/2)·σ²/n 이므로 SE(median) = √(π/2)·σ/√n.
 */
const MEDIAN_SE_FACTOR = Math.sqrt(Math.PI / 2);

/** 가중 표본의 유효 표본수 (Kish) n_eff = (Σw)² / Σw². 가중치가 모두 같으면 n과 같고, 한쪽에 쏠릴수록 작아진다 */
export function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((total, w) => total + w, 0);
  const sumSquares = weights.reduce((total, w) => total + w * w, 0);
  return sumSquares > 0 ? (sum * sum) / sumSquares : 0;
}

export interface LeakStandardError {
  /** 검정 통계량 (최근 가중 중앙값 − 기준 중앙값)의 표준오차 [kg/일] */
  readonly se: number;
  readonly nEffRecent: number;
  readonly nReference: number;
}

/**
 * 판정값은 두 로버스트 위치추정값의 차 (최근 구간 가중 중앙값 − 기준 구간 중앙값 = 겉보기 손실 편향)이다.
 * 두 항이 독립이고 구간 손실률이 σ 산포를 가지면
 *   Var = (π/2)·σ²/n_eff(최근) + (π/2)·σ²/n(기준)  →  SE = √(π/2)·σ·√(1/n_eff최근 + 1/n기준).
 * 최근은 1/CI반폭² 가중이라 유효 표본수 n_eff = (Σw)²/Σw² 를 쓴다.
 * 예전 구현은 σ/√n최근만 써서 중앙값 비효율(×1.2533)과 기준 창 불확실도(+1/n기준)를 둘 다 빼먹었고,
 * 기준 12·최근 6구간에서 실제 표준오차의 0.65배(= 명목 3σ가 실제로는 약 2σ 검정)였다.
 */
export function leakStandardError(recent: readonly HoldFit[], referenceCount: number, sigma: number): LeakStandardError {
  const nEffRecent = effectiveSampleSize(recent.map(weightOf));
  const nReference = Math.max(1, referenceCount);
  const se = MEDIAN_SE_FACTOR * sigma * Math.sqrt(1 / Math.max(1, nEffRecent) + 1 / nReference);
  return { se, nEffRecent, nReference };
}

interface Split {
  readonly reference: readonly HoldFit[];
  readonly recent: readonly HoldFit[];
}

/** 구간 선택에 필요한 값 (에피소드 features.n_points로도 만들 수 있다) */
export interface HoldMeta {
  readonly start: number;
  readonly end: number;
  readonly completeness: number;
  readonly nPoints: number;
}

/**
 * 기준·최근 구간 선택: 길이·완결성·점 수를 먼저 거르고 기준(창 또는 가장 이른 referenceHolds개)과 그 뒤 최근(recentDays 안 마지막 recentHolds개).
 * load 계층은 이 선택으로 원시 압력·온도를 읽을 구간만 고른다 (고른 구간만 넣어도 탐지기가 같은 구간을 다시 고른다).
 */
export function selectHolds<T extends HoldMeta>(holds: readonly T[], ctx: Pick<DetectorContext<TankStaticLeakParams>, 'now' | 'referenceWindow' | 'baselineResetAt'>, p: TankStaticLeakParams): { reference: T[]; recent: T[] } {
  const from = ctx.baselineResetAt ?? -Infinity;
  const eligible = [...holds]
    .filter((h) => h.start >= from && h.end <= ctx.now && (h.end - h.start) / MS_PER_HOUR >= p.minStaticHours && h.completeness >= p.minCompleteness && h.nPoints >= p.minPoints)
    .sort((a, b) => a.start - b.start);
  const window: TimeWindow | undefined = ctx.referenceWindow;
  const reference = window ? eligible.filter((h) => h.start >= window.start && h.start < window.end) : eligible.slice(0, p.referenceHolds);
  const referenceEnd = reference.at(-1)?.end ?? Infinity;
  const recent = eligible.filter((h) => h.start >= referenceEnd && h.start >= ctx.now - p.recentDays * MS_PER_DAY).slice(-p.recentHolds);
  return { reference, recent };
}

/** 구간 길이·완결성·점 수를 먼저 거르고 기준·최근 구간만 기울기를 구한다 (긴 이력에서 모든 구간을 적합하지 않도록) */
function splitHolds(holds: readonly TankHoldInput[], ctx: DetectorContext<TankStaticLeakParams>, p: TankStaticLeakParams, fit: (hold: TankHoldInput) => HoldFit | null): Split {
  const selected = selectHolds(holds.map((h) => ({ ...h, nPoints: h.points.length })), ctx, p);
  const fitAll = (items: readonly TankHoldInput[]) => items.flatMap((h) => fit(h) ?? []);
  return { reference: fitAll(selected.reference), recent: fitAll(selected.recent) };
}

function detect(input: TankStaticLeakInput, ctx: DetectorContext<TankStaticLeakParams>): DetectorResult {
  const p = withDefaults(TANK_STATIC_LEAK_DEFAULTS, ctx.params);
  if (!(input.waterVolumeL > 0)) return insufficient('저장용기 내용적(명판 water_volume_l)이 없습니다');
  const volumeM3 = input.waterVolumeL / 1000;
  const eos = h2Eos(p.eosModel, { specificGasConstant: p.specificGasConstant, coVolume: p.coVolume });
  const { reference, recent } = splitHolds(input.holds, ctx, p, (hold) => fitHold(hold, volumeM3, eos, p));
  if (reference.length < p.minReferenceHolds || recent.length < p.minRecentHolds) {
    return insufficient(`정지 보유 구간 부족: 기준 ${reference.length}개·최근 ${recent.length}개 (각 ${p.minReferenceHolds}·${p.minRecentHolds}개 필요, ${fixed(p.minStaticHours, 0)} h 이상·완결성 ${fixed(p.minCompleteness * 100, 0)}% 이상)`);
  }
  const referenceLosses = reference.map((f) => f.lossKgPerDay);
  // 구간 손실률의 로버스트 산포(MAD → σ). 기준 구간이 적으면 과소 추정될 수 있어, 구간 안 기울기 불확실도(Sen CI 반폭 ÷ 1.96)의 중앙값보다 작게 두지 않는다
  const holdSigma = median(reference.map(halfWidth)) / 1.96;
  const noise = Math.max(MAD_TO_SIGMA * mad(referenceLosses), holdSigma, p.noiseFloorKgPerDay);
  const { se, nEffRecent, nReference } = leakStandardError(recent, reference.length, noise);
  // 기준 중앙값(겉보기 손실 편향)을 뺄 수 있는 한도도 그 중앙값의 표준오차 √(π/2)·σ/√n 기준으로 둔다
  const biasLimit = (p.maxBaselineSigma * MEDIAN_SE_FACTOR * noise) / Math.sqrt(nReference);
  const bias = Math.min(biasLimit, Math.max(-biasLimit, median(referenceLosses)));
  const leak = combine(recent) - bias;
  // 부트스트랩은 최근 구간만 복원추출해 기준 창 불확실도를 담지 못하고 구간 6개에서는 폭이 좁게 나온다.
  // 두 불확도 추정(해석적 표준오차·부트스트랩) 중 넓은 쪽을 CI 반폭으로 쓴다.
  const bootstrap = bootstrapCI(recent, combine, { iterations: p.iterations, rng: ctx.rng });
  const ciHalfWidth = Math.max(1.96 * se, (bootstrap.ciHigh - bootstrap.ciLow) / 2);
  const ci = { ciLow: leak - ciHalfWidth, ciHigh: leak + ciHalfWidth };
  const threshold = p.zSigma * se;
  if (!(leak > threshold && ci.ciLow > 0)) return { status: 'ok', findings: [] };

  const safety = ci.ciLow > p.safetyKgPerDay;
  const checks = tankChecks({ fits: [...reference, ...recent], recent, leak, volumeM3, eos, crossChecks: input.pressureCrossChecks, p });
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
      `정지 보유 구간 ${recent.length}개(각 ${fixed(p.minStaticHours, 0)} h 이상)의 온도 보정 질량(${p.eosModel === 'lemmon2008' ? 'NIST 상태식' : 'Abel–Noble'})이 하루 ${fixed(leak, 3)} kg(95% CI ${fixed(ci.ciLow, 3)} ~ ${fixed(ci.ciHigh, 3)} kg${pctPerDay === null ? '' : `, 저장량의 ${fixed(pctPerDay, 2)}%`}) 줄었습니다. ` +
      `기준 구간 ${reference.length}개의 센서 잡음 수준(σ ${fixed(noise, 3)} kg/일)과 겉보기 손실 편향(${fixed(bias, 3)} kg/일, 뺌) 대비 유의합니다. ` +
      (safety ? `누설률 CI 하한이 안전 기준 ${fixed(p.safetyKgPerDay, 2)} kg/일을 넘습니다. 가스 검지기 확인과 누설 점검을 즉시 진행하고, 운전 정지 여부는 현장 안전책임자가 판단하세요.` : '가스 검지기 기록 확인과 휴대용 검지기·발포액 누설 점검을 권고합니다.') +
      ' 이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.',
    effect: { metric: 'tank_leak_kg_per_day', value: r(leak, 4) ?? 0, unit: 'kg/일', ciLow: r(ci.ciLow, 4), ciHigh: r(ci.ciHigh, 4), baseline: r(median(referenceLosses), 4), current: r(leak, 4), levelUnit: 'kg/일' },
    windowStart: reference[0]?.hold.start ?? ctx.now,
    windowEnd: recent.at(-1)?.hold.end ?? ctx.now,
    evidence: {
      ...holdEvidence({ reference, recent, leak, ci, noise, se, nEffRecent, nReference, bootstrap, threshold, pctPerDay, safety, checks, eos, volumeM3, p }),
      baseline_bias: { kg_per_day: r(bias, 4), limit_kg_per_day: r(biasLimit, 4), reference_median_kg_per_day: r(median(referenceLosses), 4) },
    },
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
