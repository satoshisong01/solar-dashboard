// 조치 효과 검증 matched_before_after@1 (순수, 설계 §3.1 조치·검증): 조치 전 창과 안정화 후 창의 에피소드 값을
// 같은 조건 bin으로 맞춰 중앙값 차이(후 − 전)를 최근 표본 수로 가중 결합하고, bin 안 재표집 부트스트랩으로 95% CI를 구한다.
// 판정: 기대 방향 효과 ≥ min_delta이고 CI가 0을 넘으면 improved, 반대 방향으로 그만큼이면 worse, 표본이 모자라면 insufficient_data.
import type { EssChargeEpisode } from '../episodes/ess';
import type { EpisodeKind } from '../episodes/types';
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import type { StoredEpisode } from '../pipeline/types';
import { resample } from '../stats/bootstrap';
import { median, quantileSorted, sortedCopy } from '../stats/robust';
import type { JsonObject, RandomSource, TimeWindow } from '../types';

export const VERIFICATION_METHOD = 'matched_before_after@1';

export type Verdict = 'improved' | 'no_change' | 'worse' | 'insufficient_data';

interface MetricSpec {
  readonly kind: EpisodeKind;
  readonly label: string;
  readonly unit: string;
  /** 좋아지는 방향 (조치 기대 효과 기본값) */
  readonly better: 'increase' | 'decrease';
  readonly value: (e: StoredEpisode) => number | null;
  readonly bin: (e: StoredEpisode) => string;
}

/** 전해조 비에너지 AC 전력 bin 폭 [kW] — el.sec_rise 기본 powerBinWidthKw와 같은 값 (이 모듈은 탐지기·zod를 가져오지 않는다) */
const EL_POWER_BIN_KW = 50;
const floorTo = (value: number | null, width: number): string => (value === null ? 'na' : String(Math.round(Math.floor(value / width + 1e-9) * width * 1e6) / 1e6));
const charge = (e: StoredEpisode): EssChargeEpisode | null => (e.kind === 'ess.charge' ? e : null);

/** maintenance_action.expected_effect.metric → 에피소드 값 */
export const VERIFICATION_METRICS: Readonly<Record<string, MetricSpec>> = {
  'ess.capacity_ah': {
    kind: 'ess.charge',
    label: '랙 유효용량',
    unit: 'Ah',
    better: 'increase',
    value: (e) => {
      const f = charge(e)?.features;
      return f ? (f.capacity_ah_anchored ?? f.capacity_ah_cc ?? f.capacity_ah_soc) : null;
    },
    bin: (e) => `${floorTo(charge(e)?.features.i_mean_c ?? null, 0.05)}|${floorTo(charge(e)?.features.t_cell_mean ?? null, 5)}`,
  },
  'ess.cell_dv_mv': { kind: 'ess.charge', label: '충전 종료 셀 전압 편차', unit: 'mV', better: 'decrease', value: (e) => charge(e)?.features.cell_dv_end ?? null, bin: () => 'all' },
  'el.v_cell_v': {
    kind: 'el.steady_run',
    label: '전해조 셀 평균 전압',
    unit: 'V',
    better: 'decrease',
    value: (e) => (e.kind === 'el.steady_run' ? e.features.v_cell_mean : null),
    bin: (e) => (e.kind === 'el.steady_run' ? `${(e as ElSteadyEpisode).conditions.j_bin}|${e.conditions.t_bin ?? 'na'}` : 'na'),
  },
  'fc.v_cell_v': {
    kind: 'fc.steady_run',
    label: '연료전지 기준 전류밀도 셀 전압',
    unit: 'V',
    better: 'increase',
    value: (e) => (e.kind === 'fc.steady_run' ? e.features.v_cell_at_jref : null),
    bin: (e) => (e.kind === 'fc.steady_run' ? `${(e as FcSteadyEpisode).conditions.t_bin ?? 'na'}` : 'na'),
  },
  // P3: 탐지기 기본 조건 bin과 같은 기준 (AC 전력 50 kW·스택온도 / 압력비·외기 / 유량·외기 / 샘플 주기·SOC·셀온도)
  'el.sec_kwh_per_kg': {
    kind: 'el.steady_run',
    label: '전해조 시스템 비에너지',
    unit: 'kWh/kg',
    better: 'decrease',
    value: (e) => (e.kind === 'el.steady_run' && (e.features.h2_kg ?? 0) >= 0.5 ? e.features.sec_kwh_per_kg : null),
    // 전력 설정값 운전에서 정류기 수리 뒤에는 같은 전력의 전류밀도가 달라지므로 전류밀도가 아닌 AC 전력 bin (el.sec_rise 기본 binBy와 같다)
    bin: (e) => (e.kind === 'el.steady_run' && e.features.energy_kwh !== null && e.features.duration_s > 0 ? `${floorTo(e.features.energy_kwh / (e.features.duration_s / 3_600), EL_POWER_BIN_KW)}|${e.conditions.t_bin ?? 'na'}` : 'na'),
  },
  'comp.sec_kwh_per_kg': {
    kind: 'comp.run',
    label: '압축기 비에너지',
    unit: 'kWh/kg',
    better: 'decrease',
    value: (e) => (e.kind === 'comp.run' && (e.features.mass_kg ?? 0) >= 1 ? e.features.sec_kwh_per_kg : null),
    bin: (e) => (e.kind === 'comp.run' ? `${e.conditions.ratio_bin ?? 'na'}|${e.conditions.t_bin ?? 'na'}` : 'na'),
  },
  'fc.blower_specific_power': {
    kind: 'fc.blower_run',
    label: '연료전지 블로워 비전력',
    unit: 'W/(kg/h)',
    better: 'decrease',
    value: (e) => (e.kind === 'fc.blower_run' ? e.features.specific_w_per_kg_h : null),
    bin: (e) => (e.kind === 'fc.blower_run' ? `${e.conditions.flow_bin}|${e.conditions.t_bin ?? 'na'}` : 'na'),
  },
  'pv.performance_index': {
    kind: 'pv.day',
    label: '인버터 일 성능지수 (비발전량 ÷ 경사면 일사량)',
    unit: '',
    better: 'increase',
    value: (e) => {
      if (e.kind !== 'pv.day' || e.conditions.curtailed || e.conditions.clipping || e.conditions.stopped) return null;
      const insolation = e.features.insolation_kwh_m2;
      return insolation !== null && insolation >= 1 ? e.features.kwh_per_kwp / insolation : null;
    },
    bin: () => 'all',
  },
  'ess.resistance_mohm': {
    kind: 'ess.current_step',
    label: '랙 전류 계단 저항',
    unit: 'mΩ',
    better: 'decrease',
    value: (e) => (e.kind === 'ess.current_step' && Math.abs(e.features.delta_i_c) >= 0.1 && e.features.soc !== null && e.features.soc >= 30 && e.features.soc < 70 ? e.features.r_mohm : null),
    bin: (e) => (e.kind === 'ess.current_step' ? `${e.features.period_s}|${e.conditions.soc_bin ?? 'na'}|${e.conditions.t_bin ?? 'na'}` : 'na'),
  },
};

export interface BeforeAfterInput {
  readonly assetId: number;
  readonly metric: string;
  readonly direction: 'increase' | 'decrease';
  readonly minDelta: number;
  readonly before: TimeWindow;
  readonly after: TimeWindow;
  readonly episodes: readonly StoredEpisode[];
  readonly rng: RandomSource;
  readonly minPerBin?: number;
  readonly minTotal?: number;
  readonly iterations?: number;
}

export interface BeforeAfterResult {
  readonly verdict: Verdict;
  /** 후 − 전 (지표 단위). 판정 불가면 null */
  readonly effect: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly beforeStats: JsonObject;
  readonly afterStats: JsonObject;
}

type Groups = Map<string, number[]>;

function groupValues(spec: MetricSpec, episodes: readonly StoredEpisode[], window: TimeWindow): Groups {
  const groups: Groups = new Map();
  for (const e of episodes) {
    if (e.kind !== spec.kind || !e.valid || e.start < window.start || e.end > window.end) continue;
    const value = spec.value(e);
    if (value === null || !Number.isFinite(value)) continue;
    groups.set(spec.bin(e), [...(groups.get(spec.bin(e)) ?? []), value]);
  }
  return groups;
}

const statsOf = (groups: Groups, window: TimeWindow): JsonObject => ({
  from: window.start,
  to: window.end,
  n: [...groups.values()].reduce((sum, v) => sum + v.length, 0),
  bins: [...groups.entries()].map(([key, values]) => ({ key, n: values.length, median: median(values) })),
});

const combine = (bins: readonly { before: readonly number[]; after: readonly number[]; weight: number }[]): number =>
  bins.reduce((sum, b) => sum + b.weight * (median(b.after) - median(b.before)), 0);

function verdictOf(input: BeforeAfterInput, effect: number, ciLow: number, ciHigh: number): Verdict {
  const sign = input.direction === 'increase' ? 1 : -1;
  const signed = sign * effect;
  const [low, high] = sign === 1 ? [ciLow, ciHigh] : [-ciHigh, -ciLow];
  if (signed >= input.minDelta && low > 0) return 'improved';
  if (signed <= -input.minDelta && high < 0) return 'worse';
  return 'no_change';
}

export function beforeAfter(input: BeforeAfterInput): BeforeAfterResult {
  const spec = VERIFICATION_METRICS[input.metric];
  const minPerBin = input.minPerBin ?? 3;
  const minTotal = input.minTotal ?? 5;
  if (!spec) return { verdict: 'insufficient_data', effect: null, ciLow: null, ciHigh: null, beforeStats: { error: `지원하지 않는 검증 지표: ${input.metric}` }, afterStats: {} };
  const own = input.episodes.filter((e) => e.assetId === input.assetId);
  const before = groupValues(spec, own, input.before);
  const after = groupValues(spec, own, input.after);
  const beforeStats = { ...statsOf(before, input.before), metric: input.metric, unit: spec.unit };
  const afterStats = statsOf(after, input.after);
  const used = [...after.keys()].filter((key) => (before.get(key)?.length ?? 0) >= minPerBin && (after.get(key)?.length ?? 0) >= minPerBin).sort();
  const nAfter = used.reduce((sum, key) => sum + (after.get(key)?.length ?? 0), 0);
  const nBefore = used.reduce((sum, key) => sum + (before.get(key)?.length ?? 0), 0);
  if (nAfter < minTotal || nBefore < minTotal) return { verdict: 'insufficient_data', effect: null, ciLow: null, ciHigh: null, beforeStats, afterStats };

  const bins = used.map((key) => ({ before: before.get(key) ?? [], after: after.get(key) ?? [], weight: (after.get(key)?.length ?? 0) / nAfter }));
  const effect = combine(bins);
  const stats = sortedCopy(Array.from({ length: input.iterations ?? 1000 }, () => combine(bins.map((b) => ({ ...b, before: resample(b.before, input.rng), after: resample(b.after, input.rng) })))));
  const ciLow = quantileSorted(stats, 0.025);
  const ciHigh = quantileSorted(stats, 0.975);
  return { verdict: verdictOf(input, effect, ciLow, ciHigh), effect, ciLow, ciHigh, beforeStats, afterStats };
}
