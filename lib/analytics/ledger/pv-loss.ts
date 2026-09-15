// PV 미활용 원인 분해 (순수).
//
// 기대 발전 [kWh] = Σ_시간 POA/1000 × kWp × PR_ref × (1 + γ·(T_mod − 25)), 실제 = 인버터 ac.power 적산.
// 인버터·시간마다 차이(기대 − 실제)를 아래 순서로 버킷이 차례로 가져간다. 한 시간이 여러 조건에 걸리면 앞 버킷이 우선이다.
//   1 outage      일사 있음 + (op.state 시간 최대 = 트립 5, 또는 시작·끝이 모두 정지 코드 0·1·4·5) → 남은 차이 전부
//   2 ess_full    출력 제한(< 99.5%) + ESS SOC(랙별 시간 최대의 평균) ≥ essFullSocPct → 남은 차이 전부
//                 (ESS가 가득 차서 걸린 출력 제한은 일반 출력제어보다 구체적인 원인이라 curtailment 앞에 둔다)
//   3 curtailment 출력 제한(ac.power.limit 시간 최소 < 99.5%) → 남은 차이 전부
//   4 clipping    시간 최대 AC ≥ 정격 × 0.99 → min(남은 차이, 기대 − 정격 × 1 h)
//   5 derating    방열판 시간 평균 ≥ deratingHeatsinkC + 비발전량이 같은 시간 동종 중앙값 × (1 − deratingPeerDrop) 미만
//                 → min(남은 차이, 동종 중앙값 × kWp − 실제). 동종(정지·출력 제한 인버터 제외)이 minPeers 미만이면 판정하지 않는다.
//   6 soiling_est 오염 탐지기 손실률 f가 입력된 인버터만 min(남은 차이, f × 기대). 없으면 0 (dq.pv.soiling_status = not_estimated)
//   7 unexplained 나머지. 실제 > 기대면 음수다(PR_ref 과소 추정 신호).
// 합계 = 기대 − 실제 가 항상 성립한다 (0.001 kWh 반올림 뒤에도 unexplained로 맞춘다).
//
// 제외: 일사계 행이 없는 시간은 모든 인버터에서, 인버터 출력 행이 없는 시간은 그 인버터에서 기대·실제를 함께 뺀다.
// 일사·모듈 온도는 사이트 기상 설비(여럿이면 경로순 첫 설비) 값을 모든 인버터에 쓴다.
// 한계: 시간 해상도라 한 시간 안 일부만 트립·클리핑돼도 그 시간 전체를 그 조건으로 본다. 출력 제한 신호 없이 계량기 송전 한도로 깎인 손실은 unexplained에 남는다.
// derating 규칙은 inv.thermal_derating 탐지기를 import할 수 없어(다른 단계에서 작성 중) 여기 복제했다. 탐지기 규칙이 정해지면 같은 함수로 합친다.
import { median } from '../stats/robust';
import { assetsOf, dayCompleteness, goodAvg, hourIntegral, hourMax, hourMin, meanOrNull, nameplateNumber, round, type LedgerContext } from './hourly';
import type { LedgerParams } from './params';
import type { PrReference, PvLossBreakdown, PvLossBucket, SiteEnergyDq } from './types';

export const PV_LOSS_ORDER = ['outage', 'ess_full', 'curtailment', 'clipping', 'derating', 'soiling_est'] as const;

/** op.state 코드 (lib/sim/events OP_STATE와 같은 값): 0 off · 1 standby · 4 stopping · 5 fault */
const OP_STATE_FAULT = 5;
const STOP_CODES: ReadonlySet<number> = new Set([0, 1, 4, OP_STATE_FAULT]);
const STC_TEMP_C = 25;

export interface HourWeather {
  readonly poa: number | null;
  /** 1 + γ(T_mod − 25). 모듈 온도가 없으면 null (보정하지 않음) */
  readonly tempFactor: number | null;
  readonly essSocPct: number | null;
}

export interface InverterHour {
  readonly assetId: number;
  readonly kwp: number;
  readonly ratedKw: number;
  /** 온도 보정한 기준 에너지 POA/1000 × kWp × 온도계수 [kWh] (PR_ref 곱하기 전) */
  readonly reference: number;
  readonly actual: number;
  readonly limited: boolean;
  readonly maxKw: number;
  readonly heatsinkC: number | null;
  readonly outage: boolean;
}

export function hourWeather(ctx: LedgerContext, params: LedgerParams, hourStart: number): HourWeather {
  const station = assetsOf(ctx, 'wx.station')[0];
  const poa = station ? goodAvg(ctx.row(station.id, 'poa.irradiance', hourStart)) : null;
  const moduleTemp = station ? goodAvg(ctx.row(station.id, 'module.temp', hourStart)) : null;
  const socs = assetsOf(ctx, 'ess.rack').map((rack) => hourMax(ctx.row(rack.id, 'batt.soc', hourStart)));
  return {
    poa: poa === null ? null : Math.max(0, poa),
    tempFactor: moduleTemp === null ? null : 1 + params.gammaPerC * (moduleTemp - STC_TEMP_C),
    essSocPct: meanOrNull(socs),
  };
}

function isOutage(ctx: LedgerContext, assetId: number, hourStart: number, sunny: boolean): boolean {
  if (!sunny) return false;
  const row = ctx.row(assetId, 'op.state', hourStart);
  if (!row || row.nGood <= 0) return false;
  const tripped = (hourMax(row) ?? 0) >= OP_STATE_FAULT;
  const stopped = row.first !== null && row.last !== null && STOP_CODES.has(row.first) && STOP_CODES.has(row.last);
  return tripped || stopped;
}

/** 일사가 있는 시간의 인버터 행. 출력 행이 없는 인버터는 빼고 개수를 센다 */
export function inverterHours(ctx: LedgerContext, params: LedgerParams, weather: HourWeather, hourStart: number): { readonly hours: InverterHour[]; readonly missing: number } {
  if (weather.poa === null) return { hours: [], missing: 0 };
  const sunny = weather.poa >= params.sunIrradiance;
  const hours: InverterHour[] = [];
  let missing = 0;
  for (const inv of assetsOf(ctx, 'pv.inverter')) {
    const kwp = nameplateNumber(inv, 'dc_kwp');
    const ratedKw = nameplateNumber(inv, 'ac_kw');
    const energy = hourIntegral(ctx.row(inv.id, 'ac.power', hourStart));
    if (kwp === null || ratedKw === null || !(kwp > 0)) continue;
    if (energy === null) {
      missing += sunny ? 1 : 0;
      continue;
    }
    hours.push({
      assetId: inv.id,
      kwp,
      ratedKw,
      reference: (weather.poa / 1000) * kwp * (weather.tempFactor ?? 1),
      actual: Math.max(0, energy),
      limited: (hourMin(ctx.row(inv.id, 'ac.power.limit', hourStart)) ?? 100) < params.limitFullPct,
      maxKw: hourMax(ctx.row(inv.id, 'ac.power', hourStart)) ?? energy,
      heatsinkC: goodAvg(ctx.row(inv.id, 'heatsink.temp', hourStart)),
      outage: isOutage(ctx, inv.id, hourStart, sunny),
    });
  }
  return { hours, missing };
}

type Claims = Readonly<Record<PvLossBucket, number>>;

export interface ClaimContext {
  readonly params: LedgerParams;
  readonly weather: HourWeather;
  readonly peerMedianYield: number | null;
  readonly soilingFraction: number | null;
}

function bucketCondition(bucket: (typeof PV_LOSS_ORDER)[number], ih: InverterHour, expected: number, c: ClaimContext): number | null {
  const { params } = c;
  switch (bucket) {
    case 'outage':
      return ih.outage ? Number.POSITIVE_INFINITY : null;
    case 'ess_full':
      return ih.limited && c.weather.essSocPct !== null && c.weather.essSocPct >= params.essFullSocPct ? Number.POSITIVE_INFINITY : null;
    case 'curtailment':
      return ih.limited ? Number.POSITIVE_INFINITY : null;
    case 'clipping':
      return ih.maxKw >= params.clippingFraction * ih.ratedKw ? Math.max(0, expected - ih.ratedKw) : null;
    case 'derating': {
      const peer = c.peerMedianYield;
      const hot = ih.heatsinkC !== null && ih.heatsinkC >= params.deratingHeatsinkC;
      return hot && peer !== null && ih.actual / ih.kwp < peer * (1 - params.deratingPeerDrop) ? Math.max(0, peer * ih.kwp - ih.actual) : null;
    }
    case 'soiling_est':
      return c.soilingFraction !== null ? Math.max(0, c.soilingFraction * expected) : null;
  }
}

/** 한 인버터·시간의 차이를 순서대로 버킷에 나눈다. 각 버킷은 자기 상한과 남은 차이 중 작은 값만 가져간다 */
export function claimLoss(ih: InverterHour, prRef: number, c: ClaimContext): Claims {
  const expected = ih.reference * prRef;
  let remaining = expected - ih.actual;
  const claims: Record<PvLossBucket, number> = { outage: 0, ess_full: 0, curtailment: 0, clipping: 0, derating: 0, soiling_est: 0, unexplained: 0 };
  for (const bucket of PV_LOSS_ORDER) {
    if (remaining <= 0) break;
    const cap = bucketCondition(bucket, ih, expected, c);
    if (cap === null) continue;
    const claim = Math.min(remaining, cap);
    claims[bucket] = claim;
    remaining -= claim;
  }
  claims.unexplained = remaining;
  return claims;
}

/** 같은 시간 동종 비발전량 중앙값. 정지·출력 제한 인버터는 동종 기준에서 뺀다 */
function peerMedian(hours: readonly InverterHour[], minPeers: number): number | null {
  const peers = hours.filter((h) => !h.outage && !h.limited);
  return peers.length >= minPeers ? median(peers.map((h) => h.actual / h.kwp)) : null;
}

export interface PvLossDay {
  readonly breakdown: PvLossBreakdown | null;
  readonly dq: SiteEnergyDq['pv'];
}

function baseDq(ctx: LedgerContext, prRef: PrReference | null, soiling: boolean): SiteEnergyDq['pv'] {
  const completeness = dayCompleteness(ctx, 'pv.inverter', 'ac.power');
  return {
    completeness: completeness === null ? null : round(completeness, 4),
    pr_ref: prRef?.value ?? null,
    pr_ref_method: prRef?.method ?? null,
    soiling_status: soiling ? 'estimated' : 'not_estimated',
    temp_corrected_ratio: null,
    no_data_inverter_hours: 0,
    reason: null,
  };
}

type Sums = Readonly<Record<PvLossBucket | 'expected' | 'actual', number>>;

const ZERO_SUMS: Sums = { expected: 0, actual: 0, outage: 0, ess_full: 0, curtailment: 0, clipping: 0, derating: 0, soiling_est: 0, unexplained: 0 };

function addClaims(sums: Sums, ih: InverterHour, prRef: number, claims: Claims): Sums {
  return {
    expected: sums.expected + ih.reference * prRef,
    actual: sums.actual + ih.actual,
    outage: sums.outage + claims.outage,
    ess_full: sums.ess_full + claims.ess_full,
    curtailment: sums.curtailment + claims.curtailment,
    clipping: sums.clipping + claims.clipping,
    derating: sums.derating + claims.derating,
    soiling_est: sums.soiling_est + claims.soiling_est,
    unexplained: sums.unexplained + claims.unexplained,
  };
}

/** 0.001 kWh 반올림. unexplained = 기대 − 실제 − 나머지 버킷 으로 다시 맞춰 합계 항등식을 지킨다 */
function roundBreakdown(sums: Sums): PvLossBreakdown {
  const r = (value: number) => round(value, 3);
  const claimed = r(sums.outage) + r(sums.ess_full) + r(sums.curtailment) + r(sums.clipping) + r(sums.derating) + r(sums.soiling_est);
  return {
    expected: r(sums.expected),
    actual: r(sums.actual),
    outage: r(sums.outage),
    ess_full: r(sums.ess_full),
    curtailment: r(sums.curtailment),
    clipping: r(sums.clipping),
    derating: r(sums.derating),
    soiling_est: r(sums.soiling_est),
    unexplained: r(r(sums.expected) - r(sums.actual) - claimed),
  };
}

/** 하루 PV 손실 분해. 인버터·일사계·PR_ref 중 하나라도 없으면 breakdown = null (dq.pv.reason) */
export function pvLossDay(ctx: LedgerContext, params: LedgerParams, prRef: PrReference | null, soilingByAssetId: ReadonlyMap<number, number>): PvLossDay {
  const dq = baseDq(ctx, prRef, soilingByAssetId.size > 0);
  if (assetsOf(ctx, 'pv.inverter').length === 0) return { breakdown: null, dq: { ...dq, reason: 'no_inverter' } };
  if (assetsOf(ctx, 'wx.station').length === 0) return { breakdown: null, dq: { ...dq, reason: 'no_poa' } };
  if (prRef === null || !(prRef.value > 0)) return { breakdown: null, dq: { ...dq, reason: 'pr_ref_missing' } };

  let sums = ZERO_SUMS;
  let missing = 0;
  let sunHours = 0;
  let correctedHours = 0;
  for (const hourStart of ctx.hours) {
    const weather = hourWeather(ctx, params, hourStart);
    const { hours, missing: absent } = inverterHours(ctx, params, weather, hourStart);
    const sunny = weather.poa !== null && weather.poa >= params.sunIrradiance;
    missing += absent;
    sunHours += sunny ? 1 : 0;
    correctedHours += sunny && weather.tempFactor !== null ? 1 : 0;
    const peer = peerMedian(hours, params.minPeers);
    for (const ih of hours) {
      const claims = claimLoss(ih, prRef.value, { params, weather, peerMedianYield: peer, soilingFraction: soilingByAssetId.get(ih.assetId) ?? null });
      sums = addClaims(sums, ih, prRef.value, claims);
    }
  }
  return {
    breakdown: roundBreakdown(sums),
    dq: { ...dq, temp_corrected_ratio: sunHours > 0 ? round(correctedHours / sunHours, 4) : null, no_data_inverter_hours: missing },
  };
}
