// pv.soiling_rate 일 성능지수·맑은 날·복원 이벤트·구간 기울기 (순수).
// PI = Σ AC 에너지 / (Σ kWp × POA 일적산 × (1 + γ·(T_일사가중 − 25)))  — 출력제한·클리핑·정지·완결성 미달·동종 이상 인버터는 그날 합계에서 뺀다.
// 맑은 날 = POA 일적산 ≥ 계절 청천 상한(±envelopeHalfDays일 최대) × clearDayRatio 이고 일중 변동 지표 ≤ maxVariability.
// 복원 = 세척 이벤트 또는 맑은 날 PI 중앙값의 급상승(앞·뒤 stepWindowDays개 비교, recoveryStepPct 이상 — 강수량 메트릭이 없어 강우 대신 쓴다).
import type { PvDayEpisode } from '../episodes/pv';
import type { WxDayEpisode } from '../episodes/wx-day';
import { median, modifiedZ } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { kstDayStart, MS_PER_DAY } from '../types';

export interface SoilingDayRules {
  readonly gammaPerC: number;
  readonly minCompleteness: number;
  readonly peerZ: number;
  readonly minEligibleShare: number;
  readonly clearDayRatio: number;
  readonly maxVariability: number;
  readonly envelopeHalfDays: number;
}

export interface InverterPi {
  readonly assetId: number;
  readonly pi: number;
}

export interface PiDay {
  readonly day: number;
  readonly pi: number;
  readonly acKwh: number;
  readonly expectedKwh: number;
  readonly clear: boolean;
  readonly poaKwhM2: number;
  readonly ghiKwhM2: number | null;
  readonly inverters: readonly InverterPi[];
}

export interface ExclusionCounts {
  readonly curtailed: number;
  readonly clipping: number;
  readonly stopped: number;
  readonly low_completeness: number;
  readonly peer_outlier: number;
}

const kwpOf = (d: PvDayEpisode): number | null => (d.features.kwh_per_kwp > 0 ? d.features.energy_kwh / d.features.kwh_per_kwp : null);

function eligibleInverters(all: readonly PvDayEpisode[], rules: SoilingDayRules, counts: Record<keyof ExclusionCounts, number>): PvDayEpisode[] {
  const eligible = all.filter((d) => {
    const reason = !d.valid || d.dq.completeness < rules.minCompleteness ? 'low_completeness' : d.conditions.curtailed ? 'curtailed' : d.conditions.clipping ? 'clipping' : d.conditions.stopped ? 'stopped' : null;
    if (reason !== null) counts[reason] += 1; // 이 함수가 만든 집계 객체만 센다
    return reason === null && kwpOf(d) !== null;
  });
  if (eligible.length < 3) return eligible;
  const values = eligible.map((d) => d.features.kwh_per_kwp);
  const zs = modifiedZ(values, { madFloor: 0.003 * median(values) });
  const kept = eligible.filter((_, i) => (zs[i] ?? 0) >= -rules.peerZ);
  counts.peer_outlier += eligible.length - kept.length;
  return kept;
}

/** 인버터 pv.day + 기상 wx.day → 일 PI. 반환 exclusions는 뺀 인버터·일 수 */
export function piDays(inverterDays: readonly PvDayEpisode[], wxDays: readonly WxDayEpisode[], rules: SoilingDayRules): { days: PiDay[]; exclusions: ExclusionCounts } {
  const counts = { curtailed: 0, clipping: 0, stopped: 0, low_completeness: 0, peer_outlier: 0 };
  const byDay = new Map<number, PvDayEpisode[]>();
  for (const d of inverterDays) {
    const key = kstDayStart(d.start);
    const list = byDay.get(key);
    if (list) list.push(d); // 이 함수 안에서 만든 배열만 채운다
    else byDay.set(key, [d]);
  }
  const wx = wxDays.filter((w) => w.valid && w.features.poa_kwh_m2 > 0).sort((a, b) => a.start - b.start);
  const days = wx.flatMap((w): PiDay[] => {
    const all = byDay.get(kstDayStart(w.start)) ?? [];
    const eligible = eligibleInverters(all, rules, counts);
    if (all.length === 0 || eligible.length / all.length < rules.minEligibleShare) return [];
    const tw = w.features.tmod_weighted_c;
    const perKwp = w.features.poa_kwh_m2 * (tw === null ? 1 : 1 + rules.gammaPerC * (tw - 25));
    const kwp = eligible.reduce((sum, d) => sum + (kwpOf(d) ?? 0), 0);
    const acKwh = eligible.reduce((sum, d) => sum + d.features.energy_kwh, 0);
    if (!(kwp > 0 && perKwp > 0)) return [];
    const envelope = Math.max(...wx.filter((x) => Math.abs(x.start - w.start) <= rules.envelopeHalfDays * MS_PER_DAY).map((x) => x.features.poa_kwh_m2));
    const variability = w.features.variability;
    const clear = w.features.poa_kwh_m2 >= rules.clearDayRatio * envelope && variability !== null && variability <= rules.maxVariability;
    return [{ day: kstDayStart(w.start), pi: acKwh / (kwp * perKwp), acKwh, expectedKwh: kwp * perKwp, clear, poaKwhM2: w.features.poa_kwh_m2, ghiKwhM2: w.features.ghi_kwh_m2, inverters: eligible.map((d) => ({ assetId: d.assetId, pi: d.features.kwh_per_kwp / perKwp })) }];
  });
  return { days, exclusions: counts };
}

export type ResetKind = 'cleaning' | 'pi_step';

export interface Reset {
  readonly day: number;
  readonly kind: ResetKind;
  /** 복원 직전·직후 맑은 날 PI 중앙값 변화 [%] (앞·뒤 데이터가 없으면 null) */
  readonly recoveryPct: number | null;
}

export interface ResetRules {
  readonly recoveryStepPct: number;
  readonly stepWindowDays: number;
}

function recoveryAt(clear: readonly PiDay[], day: number, k: number): number | null {
  const before = clear.filter((d) => d.day < day).slice(-k).map((d) => d.pi);
  const after = clear.filter((d) => d.day >= day).slice(0, k).map((d) => d.pi);
  return before.length === 0 || after.length === 0 ? null : (median(after) / median(before) - 1) * 100;
}

/** 맑은 날 PI 급상승 후보 중 이웃(맑은 날 k개 안) 묶음마다 변화가 가장 큰 날 하나 */
function stepDays(clear: readonly PiDay[], k: number, thresholdPct: number): number[] {
  const candidates = clear.flatMap((d, i) => {
    const change = i >= k && i + k <= clear.length ? recoveryAt(clear, d.day, k) : null;
    return change !== null && change >= thresholdPct ? [{ i, day: d.day, change }] : [];
  });
  const groups = candidates.reduce<{ i: number; day: number; change: number }[][]>((acc, c) => {
    const last = acc.at(-1);
    const prev = last?.at(-1);
    return last && prev && c.i - prev.i <= k ? [...acc.slice(0, -1), [...last, c]] : [...acc, [c]];
  }, []);
  return groups.map((group) => [...group].sort((a, b) => b.change - a.change)[0]?.day ?? 0);
}

/** 세척 이벤트 + 맑은 날 PI 급상승 → 복원 시점 (세척 전후 2일 안의 급상승은 세척 하나로 본다) */
export function findResets(clear: readonly PiDay[], cleaningTs: readonly number[], rules: ResetRules): Reset[] {
  const k = rules.stepWindowDays;
  const cleanings = [...new Set(cleaningTs.map((ts) => kstDayStart(ts)))].sort((a, b) => a - b);
  const steps = stepDays(clear, k, rules.recoveryStepPct).filter((day) => !cleanings.some((c) => Math.abs(c - day) <= 2 * MS_PER_DAY));
  return [...cleanings.map((day) => ({ day, kind: 'cleaning' as const })), ...steps.map((day) => ({ day, kind: 'pi_step' as const }))]
    .sort((a, b) => a.day - b.day)
    .map((reset) => ({ ...reset, recoveryPct: recoveryAt(clear, reset.day, k) }));
}

export interface Segment {
  readonly from: number;
  readonly to: number;
  readonly clearDays: readonly PiDay[];
  /** 맑은 날 PI Theil–Sen (x = 구간 시작 이후 일수) */
  readonly slope: number;
  readonly intercept: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  /** 오염 속도 [%/일] (양수 = 손실 증가), CI */
  readonly ratePctPerDay: number;
  readonly rateCiLow: number;
  readonly rateCiHigh: number;
}

/** 복원 시점으로 나눈 구간마다 맑은 날이 minClearDays 이상이면 기울기. 반환은 시간순 */
export function segmentsOf(clear: readonly PiDay[], resets: readonly Reset[], minClearDays: number, end: number): Segment[] {
  const first = clear[0]?.day;
  if (first === undefined) return [];
  const bounds = [first, ...resets.map((reset) => reset.day).filter((day) => day > first), end];
  return bounds.slice(0, -1).flatMap((from, i) => {
    const to = bounds[i + 1] as number;
    const inside = clear.filter((d) => d.day >= from && d.day < to);
    if (inside.length < minClearDays) return [];
    const xs = inside.map((d) => (d.day - from) / MS_PER_DAY);
    if (new Set(xs).size < 3) return [];
    const fit = theilSen(xs, inside.map((d) => d.pi));
    const level = fit.intercept;
    if (!(level > 0)) return [];
    return [{ from, to, clearDays: inside, slope: fit.slope, intercept: fit.intercept, ciLow: fit.ciLow, ciHigh: fit.ciHigh, ratePctPerDay: (-fit.slope / level) * 100, rateCiLow: (-fit.ciHigh / level) * 100, rateCiHigh: (-fit.ciLow / level) * 100 }];
  });
}

/** 구간 기울기로 본 x일 뒤 누적 손실 [%] (음수는 0) */
export const lossPctAt = (segment: Segment, day: number): number => Math.max(0, segment.ratePctPerDay * ((day - segment.from) / MS_PER_DAY));
