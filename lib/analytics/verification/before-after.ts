// 조치 효과 검증 matched_before_after@1 (순수, 설계 §3.1 조치·검증): 조치 전 창과 안정화 후 창의 에피소드 값을
// 같은 조건 bin으로 맞춰 중앙값 차이(후 − 전)를 최근 표본 수로 가중 결합하고, bin 안 재표집 부트스트랩으로 95% CI를 구한다.
// 판정: 기대 방향 효과 ≥ min_delta이고 CI가 0을 넘으면 improved, 반대 방향으로 그만큼이면 worse, 표본이 모자라면 insufficient_data.
//
// 표본 방식(method): 지표 대부분은 '에피소드 하나 = 표본 하나'(episode) 한 가지다. 용량(ess.capacity_ah)만
// 탐지기와 같은 우선순위 — CV 종료 앵커 > 휴지 앵커 > CC 구간 Ah > 부분 충전 SOC 변화 — 로 여러 방식을 쓴다
// (연계형 사이트는 만충 앵커 세션이 드물어 충전 세션 방식만으로는 데이터 부족으로 끝난다).
// 앞에서부터 전·후 창 모두 표본이 차는 첫 방식을 골라 그 방식으로만 비교한다. 전은 앵커, 후는 CC처럼
// 방식이 다른 값을 맞비교하면 방식 차이가 조치 효과로 보이므로, 같은 방식으로 양쪽이 차지 않으면 insufficient_data다.
// 쓴 방식은 before_stats·after_stats.method에, 판정 불능이면 방식별 표본 수를 before_stats.methods에 남긴다.
import { DEFAULT_ESS_EXTRACTOR_PARAMS } from '../episodes/ess';
import type { EssChargeEpisode, EssDischargeEpisode, EssRestEpisode } from '../episodes/ess';
import type { EpisodeKind } from '../episodes/types';
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import { CAPACITY_METHOD_LABELS, CAPACITY_METHOD_ORDER, CAPACITY_SAMPLE_RULE_DEFAULTS, restPairSamples, sessionSamples, type CapacityMethod, type CapacitySample } from '../detectors/ess-capacity-samples';
import type { StoredEpisode } from '../pipeline/types';
import { resample } from '../stats/bootstrap';
import { median, quantileSorted, sortedCopy } from '../stats/robust';
import type { JsonObject, RandomSource, TimeWindow } from '../types';

export const VERIFICATION_METHOD = 'matched_before_after@1';

/** 방식이 하나뿐인 지표의 방식 id (에피소드 하나 = 표본 하나) */
export const SINGLE_SAMPLE_METHOD = 'episode';

/** 표본 방식 표시 이름 (근거·리포트 공용). 모르는 값이면 방식 id를 그대로 보여 준다 */
export const sampleMethodLabel = (method: string): string =>
  method === SINGLE_SAMPLE_METHOD ? '에피소드 값' : (CAPACITY_METHOD_LABELS[method as CapacityMethod] ?? method);

export type Verdict = 'improved' | 'no_change' | 'worse' | 'insufficient_data';

type Groups = Map<string, number[]>;

interface MethodInput {
  /** 대상 설비로만 거른 에피소드 전체. 창 밖도 들어온다 (휴지 앵커 쌍은 창 경계를 넘어 계산한 뒤 창 안 표본만 쓴다) */
  readonly episodes: readonly StoredEpisode[];
  readonly window: TimeWindow;
  /** 랙 정격 용량 [Ah] — 휴지 앵커 방식에만 필요하다. 없으면 그 방식은 표본 0 */
  readonly ratedCapacityAh: number | null;
}

/** 표본을 뽑는 방식 하나 */
interface SampleMethod {
  readonly id: string;
  readonly group: (input: MethodInput) => Groups;
}

interface MetricSpec {
  /** 조치 폼이 설비 종류로 지표를 거를 때 쓰는 대표 에피소드 종류 */
  readonly kind: EpisodeKind;
  readonly label: string;
  readonly unit: string;
  /** 좋아지는 방향 (조치 기대 효과 기본값) */
  readonly better: 'increase' | 'decrease';
  /** 우선순위대로 시도하는 표본 방식 (대부분 하나) */
  readonly methods: readonly SampleMethod[];
}

/** 전해조 비에너지 AC 전력 bin 폭 [kW] — el.sec_rise 기본 powerBinWidthKw와 같은 값 (이 모듈은 zod를 가져오지 않는다) */
const EL_POWER_BIN_KW = 50;
const floorTo = (value: number | null, width: number): string => (value === null ? 'na' : String(Math.round(Math.floor(value / width + 1e-9) * width * 1e6) / 1e6));
const charge = (e: StoredEpisode): EssChargeEpisode | null => (e.kind === 'ess.charge' ? e : null);

const addTo = (groups: Groups, key: string, value: number): void => {
  groups.set(key, [...(groups.get(key) ?? []), value]);
};

/** 에피소드 하나 = 표본 하나인 방식. 창 안에 통째로 든 유효 에피소드만 쓴다 */
function episodeMethod(kind: EpisodeKind, value: (e: StoredEpisode) => number | null, bin: (e: StoredEpisode) => string): readonly SampleMethod[] {
  return [
    {
      id: SINGLE_SAMPLE_METHOD,
      group: ({ episodes, window }) => {
        const groups: Groups = new Map(); // 이 함수 안에서만 채운다
        for (const e of episodes) {
          if (e.kind !== kind || !e.valid || e.start < window.start || e.end > window.end) continue;
          const v = value(e);
          if (v === null || !Number.isFinite(v)) continue;
          addTo(groups, bin(e), v);
        }
        return groups;
      },
    },
  ];
}

const byKind = <T extends StoredEpisode['kind']>(episodes: readonly StoredEpisode[], kind: T): Extract<StoredEpisode, { kind: T }>[] =>
  episodes.filter((e): e is Extract<StoredEpisode, { kind: T }> => e.kind === kind);

/** 용량 표본 → 창 안 것만 bin별로. 가중치는 쓰지 않는다 (검증은 bin 중앙값 차이만 본다) */
function groupCapacitySamples(samples: readonly CapacitySample[], window: TimeWindow): Groups {
  const groups: Groups = new Map(); // 이 함수 안에서만 채운다
  for (const s of samples) {
    if (s.start < window.start || s.end > window.end || !Number.isFinite(s.value)) continue;
    addTo(groups, s.bin, s.value);
  }
  return groups;
}

/** 탐지기(ess.capacity_fade)와 같은 우선순위·같은 표본 규칙 */
const CAPACITY_METHODS: readonly SampleMethod[] = CAPACITY_METHOD_ORDER.map((method: CapacityMethod) => ({
  id: method,
  group: ({ episodes, window, ratedCapacityAh }: MethodInput): Groups => {
    const charges: EssChargeEpisode[] = byKind(episodes, 'ess.charge');
    if (method !== 'rest_anchored') return groupCapacitySamples(sessionSamples(charges, method, CAPACITY_SAMPLE_RULE_DEFAULTS), window);
    if (ratedCapacityAh === null || !(ratedCapacityAh > 0)) return new Map();
    const discharges: EssDischargeEpisode[] = byKind(episodes, 'ess.discharge');
    const rests: EssRestEpisode[] = byKind(episodes, 'ess.rest');
    const rules = { ...CAPACITY_SAMPLE_RULE_DEFAULTS, restThresholdC: DEFAULT_ESS_EXTRACTOR_PARAMS.thresholdC };
    return groupCapacitySamples(restPairSamples({ ratedCapacityAh, charges, discharges, rests }, rules), window);
  },
}));

/** maintenance_action.expected_effect.metric → 표본 방식 */
export const VERIFICATION_METRICS: Readonly<Record<string, MetricSpec>> = {
  'ess.capacity_ah': { kind: 'ess.charge', label: '랙 유효용량', unit: 'Ah', better: 'increase', methods: CAPACITY_METHODS },
  'ess.cell_dv_mv': { kind: 'ess.charge', label: '충전 종료 셀 전압 편차', unit: 'mV', better: 'decrease', methods: episodeMethod('ess.charge', (e) => charge(e)?.features.cell_dv_end ?? null, () => 'all') },
  'el.v_cell_v': {
    kind: 'el.steady_run',
    label: '전해조 셀 평균 전압',
    unit: 'V',
    better: 'decrease',
    methods: episodeMethod(
      'el.steady_run',
      (e) => (e.kind === 'el.steady_run' ? e.features.v_cell_mean : null),
      (e) => (e.kind === 'el.steady_run' ? `${(e as ElSteadyEpisode).conditions.j_bin}|${e.conditions.t_bin ?? 'na'}` : 'na'),
    ),
  },
  'fc.v_cell_v': {
    kind: 'fc.steady_run',
    label: '연료전지 기준 전류밀도 셀 전압',
    unit: 'V',
    better: 'increase',
    methods: episodeMethod(
      'fc.steady_run',
      (e) => (e.kind === 'fc.steady_run' ? e.features.v_cell_at_jref : null),
      (e) => (e.kind === 'fc.steady_run' ? `${(e as FcSteadyEpisode).conditions.t_bin ?? 'na'}` : 'na'),
    ),
  },
  // P3: 탐지기 기본 조건 bin과 같은 기준 (AC 전력 50 kW·스택온도 / 압력비·외기 / 유량·외기 / 샘플 주기·SOC·셀온도)
  'el.sec_kwh_per_kg': {
    kind: 'el.steady_run',
    label: '전해조 시스템 비에너지',
    unit: 'kWh/kg',
    better: 'decrease',
    methods: episodeMethod(
      'el.steady_run',
      (e) => (e.kind === 'el.steady_run' && (e.features.h2_kg ?? 0) >= 0.5 ? e.features.sec_kwh_per_kg : null),
      // 전력 설정값 운전에서 정류기 수리 뒤에는 같은 전력의 전류밀도가 달라지므로 전류밀도가 아닌 AC 전력 bin (el.sec_rise 기본 binBy와 같다)
      (e) => (e.kind === 'el.steady_run' && e.features.energy_kwh !== null && e.features.duration_s > 0 ? `${floorTo(e.features.energy_kwh / (e.features.duration_s / 3_600), EL_POWER_BIN_KW)}|${e.conditions.t_bin ?? 'na'}` : 'na'),
    ),
  },
  'comp.sec_kwh_per_kg': {
    kind: 'comp.run',
    label: '압축기 비에너지',
    unit: 'kWh/kg',
    better: 'decrease',
    methods: episodeMethod(
      'comp.run',
      (e) => (e.kind === 'comp.run' && (e.features.mass_kg ?? 0) >= 1 ? e.features.sec_kwh_per_kg : null),
      (e) => (e.kind === 'comp.run' ? `${e.conditions.ratio_bin ?? 'na'}|${e.conditions.t_bin ?? 'na'}` : 'na'),
    ),
  },
  'fc.blower_specific_power': {
    kind: 'fc.blower_run',
    label: '연료전지 블로워 비전력',
    unit: 'W/(kg/h)',
    better: 'decrease',
    methods: episodeMethod(
      'fc.blower_run',
      (e) => (e.kind === 'fc.blower_run' ? e.features.specific_w_per_kg_h : null),
      (e) => (e.kind === 'fc.blower_run' ? `${e.conditions.flow_bin}|${e.conditions.t_bin ?? 'na'}` : 'na'),
    ),
  },
  'pv.performance_index': {
    kind: 'pv.day',
    label: '인버터 일 성능지수 (비발전량 ÷ 경사면 일사량)',
    unit: '',
    better: 'increase',
    methods: episodeMethod(
      'pv.day',
      (e) => {
        if (e.kind !== 'pv.day' || e.conditions.curtailed || e.conditions.clipping || e.conditions.stopped) return null;
        const insolation = e.features.insolation_kwh_m2;
        return insolation !== null && insolation >= 1 ? e.features.kwh_per_kwp / insolation : null;
      },
      () => 'all',
    ),
  },
  'ess.resistance_mohm': {
    kind: 'ess.current_step',
    label: '랙 전류 계단 저항',
    unit: 'mΩ',
    better: 'decrease',
    methods: episodeMethod(
      'ess.current_step',
      (e) => (e.kind === 'ess.current_step' && Math.abs(e.features.delta_i_c) >= 0.1 && e.features.soc !== null && e.features.soc >= 30 && e.features.soc < 70 ? e.features.r_mohm : null),
      (e) => (e.kind === 'ess.current_step' ? `${e.features.period_s}|${e.conditions.soc_bin ?? 'na'}|${e.conditions.t_bin ?? 'na'}` : 'na'),
    ),
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
  /** 랙 정격 용량 [Ah] (om.asset 명판). 용량 지표의 휴지 앵커 방식에만 쓴다 */
  readonly ratedCapacityAh?: number | null;
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

const statsOf = (groups: Groups, window: TimeWindow, method: string): JsonObject => ({
  from: window.start,
  to: window.end,
  method,
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

/** 한 방식으로 뽑은 전·후 표본과, bin당 minPerBin을 넘겨 실제로 비교에 쓸 수 있는 bin */
interface MethodAttempt {
  readonly method: string;
  readonly before: Groups;
  readonly after: Groups;
  readonly usedBins: readonly string[];
  readonly nBefore: number;
  readonly nAfter: number;
}

function attempt(method: SampleMethod, input: BeforeAfterInput, episodes: readonly StoredEpisode[], minPerBin: number): MethodAttempt {
  const rated = input.ratedCapacityAh ?? null;
  const before = method.group({ episodes, window: input.before, ratedCapacityAh: rated });
  const after = method.group({ episodes, window: input.after, ratedCapacityAh: rated });
  const usedBins = [...after.keys()].filter((key) => (before.get(key)?.length ?? 0) >= minPerBin && (after.get(key)?.length ?? 0) >= minPerBin).sort();
  return {
    method: method.id,
    before,
    after,
    usedBins,
    nBefore: usedBins.reduce((sum, key) => sum + (before.get(key)?.length ?? 0), 0),
    nAfter: usedBins.reduce((sum, key) => sum + (after.get(key)?.length ?? 0), 0),
  };
}

/** 판정 불능일 때 방식별로 무엇이 모자랐는지 (전·후 전체 표본 수와 맞춰진 bin 표본 수) */
const methodsNote = (attempts: readonly MethodAttempt[]): JsonObject[] =>
  attempts.map((a) => ({
    method: a.method,
    before: [...a.before.values()].reduce((sum, v) => sum + v.length, 0),
    after: [...a.after.values()].reduce((sum, v) => sum + v.length, 0),
    matched_bins: a.usedBins.length,
    matched_before: a.nBefore,
    matched_after: a.nAfter,
  }));

export function beforeAfter(input: BeforeAfterInput): BeforeAfterResult {
  const spec = VERIFICATION_METRICS[input.metric];
  const minPerBin = input.minPerBin ?? 3;
  const minTotal = input.minTotal ?? 5;
  if (!spec) return { verdict: 'insufficient_data', effect: null, ciLow: null, ciHigh: null, beforeStats: { error: `지원하지 않는 검증 지표: ${input.metric}` }, afterStats: {} };
  const own = input.episodes.filter((e) => e.assetId === input.assetId);
  const attempts: MethodAttempt[] = []; // 우선순위대로 시도한 방식을 모은다 (이 함수 안에서만 누적)
  for (const method of spec.methods) {
    const tried = attempt(method, input, own, minPerBin);
    attempts.push(tried);
    if (tried.nBefore < minTotal || tried.nAfter < minTotal) continue;

    const beforeStats = { ...statsOf(tried.before, input.before, tried.method), metric: input.metric, unit: spec.unit };
    const afterStats = statsOf(tried.after, input.after, tried.method);
    const bins = tried.usedBins.map((key) => ({ before: tried.before.get(key) ?? [], after: tried.after.get(key) ?? [], weight: (tried.after.get(key)?.length ?? 0) / tried.nAfter }));
    const effect = combine(bins);
    const draws = sortedCopy(Array.from({ length: input.iterations ?? 1000 }, () => combine(bins.map((b) => ({ ...b, before: resample(b.before, input.rng), after: resample(b.after, input.rng) })))));
    const ciLow = quantileSorted(draws, 0.025);
    const ciHigh = quantileSorted(draws, 0.975);
    return { verdict: verdictOf(input, effect, ciLow, ciHigh), effect, ciLow, ciHigh, beforeStats, afterStats };
  }
  // 어떤 방식도 전·후 양쪽을 채우지 못했다 — 우선순위 첫 방식의 표본을 보여 주고 방식별 표본 수를 함께 남긴다
  const first = attempts[0];
  const firstMethod = first?.method ?? SINGLE_SAMPLE_METHOD;
  const beforeStats = {
    ...statsOf(first?.before ?? new Map(), input.before, firstMethod),
    metric: input.metric,
    unit: spec.unit,
    ...(spec.methods.length > 1 ? { methods: methodsNote(attempts) } : {}),
  };
  return { verdict: 'insufficient_data', effect: null, ciLow: null, ciHigh: null, beforeStats, afterStats: statsOf(first?.after ?? new Map(), input.after, firstMethod) };
}
