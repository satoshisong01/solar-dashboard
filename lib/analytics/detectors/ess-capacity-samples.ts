// ess.capacity_fade 용량 표본 (순수): 충전 세션 방식(앵커·CC·SOC 변화)과 휴지 앵커 방식(rest_anchored)을 같은 표본 모양으로 만든다.
// 휴지 앵커: 휴지(|I| ≤ 0.02C, restMinutes 이상) 끝 SOC 두 점 사이 순 Ah(충전 − 방전 + 휴지 중 미소 전류) ÷ ΔSOC.
//   휴지 끝 SOC는 BMS가 휴지 OCV로 재보정했을 가능성이 높은 시점이라, 충전 중 순간 SOC를 쓰는 방식(capacity_ah_soc)보다 순환 논리가 약하다.
//   두 앵커 사이에 충방전이 섞여도 되지만, 그 사이 에피소드가 구간을 거의 빈틈없이 덮어야(순 Ah 누락 방지) 쓴다.
import type { EssChargeEpisode, EssDischargeEpisode, EssRestEpisode } from '../episodes/ess';
import { binFloor } from '../episodes/series';
import { MS_PER_HOUR } from '../types';

export type CapacityMethod = 'capacity_ah_anchored' | 'rest_anchored' | 'capacity_ah_cc' | 'capacity_ah_soc';

/** 우선순위: CV 종료 앵커 > 휴지 앵커 > CC 구간 Ah > 부분 충전 SOC 변화 (뒤로 갈수록 BMS 순간 SOC 의존이 크다) */
export const CAPACITY_METHOD_ORDER: readonly CapacityMethod[] = ['capacity_ah_anchored', 'rest_anchored', 'capacity_ah_cc', 'capacity_ah_soc'];

export type SessionMetric = Exclude<CapacityMethod, 'rest_anchored'>;

/** 방식이 같은 용량 표본 하나 (충전 세션 하나 또는 휴지 앵커 한 쌍) */
export interface CapacitySample {
  readonly start: number;
  readonly end: number;
  /** 추정 유효용량 [Ah] */
  readonly value: number;
  /** matchedRatio 가중치: 세션 방식 1, 휴지 앵커는 추정 상대분산의 역수 */
  readonly weight: number;
  /** 같은 조건 bin 키: 세션 'C-rate bin|셀온도 bin', 휴지 앵커 '방향(chg·dis)|셀온도 bin' */
  readonly bin: string;
  readonly completeness: number;
}

export interface SessionSampleRules {
  readonly cRateBinWidth: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
}

const tempKey = (t: number | null, width: number): string => (t === null ? 'na' : String(binFloor(t, width)));

/** 충전 세션 → 표본 (값이 없거나 무효·완결성 미달인 세션은 뺀다) */
export function sessionSamples(sessions: readonly EssChargeEpisode[], metric: SessionMetric, rules: SessionSampleRules): CapacitySample[] {
  return sessions.flatMap((s) => {
    const value = s.features[metric];
    if (!s.valid || value === null || !Number.isFinite(value) || s.dq.completeness < rules.minCompleteness) return [];
    return [{ start: s.start, end: s.end, value, weight: 1, bin: `${binFloor(s.features.i_mean_c, rules.cRateBinWidth)}|${tempKey(s.features.t_cell_mean, rules.tempBinWidthC)}`, completeness: s.dq.completeness }];
  });
}

export interface RestPairRules {
  readonly restMinutes: number;
  /** |ΔSOC| 하한 [%p] */
  readonly minDeltaSocRest: number;
  /** 휴지 끝 SOC 1σ 불확도 [%p] (두 점 → √2배) */
  readonly socSigmaPct: number;
  /** 전류 적분 상대 오차 1σ (충방전 처리량에 비례) */
  readonly currentGainSigma: number;
  /** 두 앵커 사이 최대 길이 [h] (길수록 쿨롱 효율 누적 오차가 커진다) */
  readonly restPairMaxHours: number;
  /** 두 앵커 사이를 에피소드가 덮는 비율 하한 */
  readonly restPairMinCoverage: number;
  readonly tempBinWidthC: number;
  readonly minCompleteness: number;
  /** 에피소드에 잡히지 않은 시간에 흐를 수 있는 최대 전류 = 휴지 임계 [C] */
  readonly restThresholdC: number;
}

export interface RestPairInput {
  readonly ratedCapacityAh: number;
  readonly charges: readonly EssChargeEpisode[];
  readonly discharges: readonly EssDischargeEpisode[];
  readonly rests: readonly EssRestEpisode[];
}

type AnyEss = EssChargeEpisode | EssDischargeEpisode | EssRestEpisode;

/** 정격의 50~150% 밖 추정은 SOC 점프·전류 누락으로 보고 버린다 */
const PLAUSIBLE_RATIO = [0.5, 1.5] as const;

function signedAh(e: AnyEss): number {
  switch (e.kind) {
    case 'ess.charge':
      return e.features.ah_in;
    case 'ess.discharge':
      return -e.features.ah_out;
    case 'ess.rest':
      return e.features.ah_net;
  }
}

interface Between {
  readonly netAh: number;
  readonly throughputAh: number;
  readonly coveredMs: number;
  readonly completeness: number;
  readonly tCell: number | null;
}

/** 두 앵커 사이(a.end ~ b.end) 에피소드 합계. 무효·완결성 미달·순 Ah 모름이 섞이면 null */
function betweenOf(episodes: readonly AnyEss[], minCompleteness: number): Between | null {
  let netAh = 0; // 이 함수 안에서만 누적한다
  let throughputAh = 0;
  let coveredMs = 0;
  let tWeighted = 0;
  let tMs = 0;
  let completeness = 1;
  for (const e of episodes) {
    const ah = signedAh(e);
    if (!e.valid || e.dq.completeness < minCompleteness || !Number.isFinite(ah)) return null;
    const ms = e.end - e.start;
    netAh += ah;
    throughputAh += Math.abs(ah);
    coveredMs += ms;
    completeness = Math.min(completeness, e.dq.completeness);
    if (e.features.t_cell_mean !== null) {
      tWeighted += e.features.t_cell_mean * ms;
      tMs += ms;
    }
  }
  return { netAh, throughputAh, coveredMs, completeness, tCell: tMs > 0 ? tWeighted / tMs : null };
}

const isAnchor = (rules: RestPairRules) => (r: EssRestEpisode): boolean =>
  r.valid && r.dq.completeness >= rules.minCompleteness && r.features.duration_s >= rules.restMinutes * 60 && r.features.soc_end !== null && Number.isFinite(r.features.soc_end);

/**
 * 휴지 앵커 표본: 연속한 두 앵커 a → b마다
 *   용량 = 순 Ah ÷ (ΔSOC/100),  ΔSOC = SOC_b − SOC_a (|ΔSOC| ≥ minDeltaSocRest, 순 Ah와 부호가 같아야 함)
 *   상대분산 = (√2·socSigmaPct / |ΔSOC|)² + ((currentGainSigma·처리량 Ah + restThresholdC·정격·미포함 시간 h) / |순 Ah|)²
 *   가중치 = 1 / 상대분산  → ΔSOC가 작을수록·처리량이 클수록·빈틈이 클수록 가중치가 작다
 *   bin = 방향(ΔSOC 부호: 충전 chg / 방전 dis) × 셀온도 bin — 쿨롱 효율·LFP OCV 히스테리시스가 방향마다 다르다
 */
export function restPairSamples(input: RestPairInput, rules: RestPairRules): CapacitySample[] {
  if (!(input.ratedCapacityAh > 0)) return [];
  const anchors = input.rests.filter(isAnchor(rules)).sort((a, b) => a.end - b.end);
  const episodes: AnyEss[] = [...input.charges, ...input.discharges, ...input.rests].sort((a, b) => a.start - b.start);
  const samples: CapacitySample[] = [];
  let cursor = 0;
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i - 1] as EssRestEpisode;
    const b = anchors[i] as EssRestEpisode;
    const spanMs = b.end - a.end;
    while (cursor < episodes.length && (episodes[cursor] as AnyEss).start < a.end) cursor += 1;
    const inside: AnyEss[] = [];
    for (let j = cursor; j < episodes.length && (episodes[j] as AnyEss).start < b.end; j += 1) if ((episodes[j] as AnyEss).end <= b.end) inside.push(episodes[j] as AnyEss);
    const between = spanMs > 0 && spanMs <= rules.restPairMaxHours * MS_PER_HOUR ? betweenOf(inside, rules.minCompleteness) : null;
    const dSoc = (b.features.soc_end ?? Number.NaN) - (a.features.soc_end ?? Number.NaN);
    if (!between || between.coveredMs / spanMs < rules.restPairMinCoverage || !(Math.abs(dSoc) >= rules.minDeltaSocRest) || Math.sign(between.netAh) !== Math.sign(dSoc)) continue;
    const value = between.netAh / (dSoc / 100);
    if (value < PLAUSIBLE_RATIO[0] * input.ratedCapacityAh || value > PLAUSIBLE_RATIO[1] * input.ratedCapacityAh) continue;
    const uncoveredH = Math.max(0, spanMs - between.coveredMs) / MS_PER_HOUR;
    const ahError = rules.currentGainSigma * between.throughputAh + rules.restThresholdC * input.ratedCapacityAh * uncoveredH;
    const relVariance = ((Math.SQRT2 * rules.socSigmaPct) / Math.abs(dSoc)) ** 2 + (ahError / Math.abs(between.netAh)) ** 2;
    samples.push({ start: a.end, end: b.end, value, weight: 1 / relVariance, bin: `${dSoc > 0 ? 'chg' : 'dis'}|${tempKey(between.tCell, rules.tempBinWidthC)}`, completeness: between.completeness });
  }
  return samples;
}
