import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { EL_SEC_RISE_DEFAULTS } from '../detectors/el-sec-rise';
import { chargeSession, DAY0, elRuns, partialCycleDay, pvDay } from '../detectors/test-fixtures';
import type { ElSteadyEpisode } from '../episodes/stack-episodes';
import type { StoredEpisode } from '../pipeline/types';
import { MS_PER_DAY } from '../types';
import { beforeAfter, VERIFICATION_METRICS } from './before-after';

const before = { start: DAY0, end: DAY0 + 10 * MS_PER_DAY };
const after = { start: DAY0 + 12 * MS_PER_DAY, end: DAY0 + 22 * MS_PER_DAY };

function dvSessions(beforeMv: number, afterMv: number): StoredEpisode[] {
  const rng = createRng(4);
  return Array.from({ length: 22 }, (_, day) => chargeSession({ day, capacityAh: 400, dvMv: (day < 11 ? beforeMv : afterMv) + 0.3 * rng.gaussian() }));
}

/** 용량 표본 하나짜리 비교: 방식 고르기만 보려고 bin·합계 하한을 1로 내린다 */
const capacity = (episodes: readonly StoredEpisode[], ratedCapacityAh: number | null = null) =>
  beforeAfter({ assetId: 7, metric: 'ess.capacity_ah', direction: 'increase', minDelta: 1, before, after, episodes, ratedCapacityAh, rng: createRng(9), minPerBin: 1, minTotal: 1 });

describe('matched_before_after@1', () => {
  it('셀 전압 편차가 줄면(감소 기대) improved, CI는 0 아래', () => {
    const result = beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(30, 12), rng: createRng(1) });
    expect(result.verdict).toBe('improved');
    expect(result.effect).toBeCloseTo(-18, 0);
    expect(result.ciHigh).toBeLessThan(0);
    expect(result.beforeStats).toMatchObject({ metric: 'ess.cell_dv_mv', unit: 'mV', n: 10, method: 'episode' });
    expect(result.afterStats).toMatchObject({ n: 10, method: 'episode' });
  });

  it('반대로 커지면 worse, 작은 변화는 no_change, 표본이 모자라거나 모르는 지표면 insufficient_data', () => {
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 30), rng: createRng(2) }).verdict).toBe('worse');
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 11), rng: createRng(3) }).verdict).toBe('no_change');
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: dvSessions(12, 11).slice(0, 13), rng: createRng(3) })).toMatchObject({ verdict: 'insufficient_data', effect: null });
    expect(beforeAfter({ assetId: 7, metric: 'x.unknown', direction: 'increase', minDelta: 1, before, after, episodes: [], rng: createRng(3) }).beforeStats).toEqual({ error: '지원하지 않는 검증 지표: x.unknown' });
    // 방식이 하나인 지표는 방식별 내역을 남기지 않는다
    expect(beforeAfter({ assetId: 7, metric: 'ess.cell_dv_mv', direction: 'decrease', minDelta: 5, before, after, episodes: [], rng: createRng(3) }).beforeStats).not.toHaveProperty('methods');
  });

  it('용량(C-rate×온도 bin)·전해조 셀 전압 지표 값을 에피소드에서 읽는다', () => {
    const sessions = [1, 2, 3, 14, 15, 16].map((day) => chargeSession({ day, capacityAh: 400, anchored: false, ccCapacity: false }));
    expect(capacity(sessions).beforeStats).toMatchObject({ method: 'capacity_ah_soc', n: 3, bins: [{ key: '0.1|25', n: 3, median: 398 }] });

    const run = { ...elRuns({ count: 2, startHours: 1200, endHours: 1300, rateUvPerH: 0, seed: 1 })[0], assetId: 7 } as ElSteadyEpisode;
    const elWindow = (e: ElSteadyEpisode, day: number): StoredEpisode => ({ ...e, start: DAY0 + day * MS_PER_DAY, end: DAY0 + day * MS_PER_DAY + 3_600_000 });
    const elResult = beforeAfter({
      assetId: 7,
      metric: 'el.v_cell_v',
      direction: 'decrease',
      minDelta: 0.001,
      before,
      after,
      episodes: [elWindow(run, 1), elWindow(run, 14)],
      rng: createRng(5),
      minPerBin: 1,
      minTotal: 1,
    });
    expect((elResult.beforeStats as { bins: { key: string; median: number }[] }).bins[0]?.median).toBeGreaterThan(1.5);
    expect((elResult.beforeStats as { bins: { key: string }[] }).bins[0]?.key).toBe(`${run.conditions.j_bin}|${run.conditions.t_bin}`);

    // 전해조 비에너지는 el.sec_rise 기본값과 같은 AC 전력 bin: 400 kWh / 1 h → 400 kW 구간
    const secResult = beforeAfter({ assetId: 7, metric: 'el.sec_kwh_per_kg', direction: 'decrease', minDelta: 0.1, before, after, episodes: [elWindow(run, 1), elWindow(run, 14)], rng: createRng(5), minPerBin: 1, minTotal: 1 });
    expect((secResult.beforeStats as { bins: { key: string }[] }).bins[0]?.key).toBe(`${400 - (400 % EL_SEC_RISE_DEFAULTS.powerBinWidthKw)}|${run.conditions.t_bin}`);
  });

  it('탐지기와 같은 우선순위로 방식을 고른다: 앵커 > 휴지 앵커 > CC > SOC 변화', () => {
    const anchored = [1, 2, 3, 14, 15, 16].map((day) => chargeSession({ day, capacityAh: 400 }));
    expect(capacity(anchored).beforeStats).toMatchObject({ method: 'capacity_ah_anchored' });
    const ccOnly = [1, 2, 3, 14, 15, 16].map((day) => chargeSession({ day, capacityAh: 400, anchored: false }));
    expect(capacity(ccOnly).beforeStats).toMatchObject({ method: 'capacity_ah_cc' });
    // 휴지 앵커는 CC보다 앞선다 (부분 사이클이 섞인 날에도 앵커 쌍이 있으면 그쪽을 쓴다)
    const withRests = [...ccOnly, ...[1, 14].flatMap((day) => partialCycleDay({ day, capacityAh: 400 }))] as StoredEpisode[];
    expect(capacity(withRests, 400).beforeStats).toMatchObject({ method: 'rest_anchored' });
    // 정격 용량을 모르면 휴지 앵커 방식을 못 쓰고 CC로 내려간다
    expect(capacity(withRests, null).beforeStats).toMatchObject({ method: 'capacity_ah_cc' });
  });

  it('부분 사이클(만충 앵커 없음)에서 휴지 앵커 방식으로 용량 회복을 improved로 본다', () => {
    const episodes = [
      ...[1, 2, 3, 4, 5].flatMap((day) => partialCycleDay({ day, capacityAh: 380 })),
      ...[14, 15, 16, 17, 18].flatMap((day) => partialCycleDay({ day, capacityAh: 400 })),
    ] as StoredEpisode[];
    // 충전 세션 방식은 표본이 0이다 (앵커·CV 종료·40%p 이상 SOC 변화가 없다)
    const result = beforeAfter({ assetId: 7, metric: 'ess.capacity_ah', direction: 'increase', minDelta: 5, before, after, episodes, ratedCapacityAh: 400, rng: createRng(11) });
    expect(result.verdict).toBe('improved');
    expect(result.effect).toBeCloseTo(20, 6);
    expect(result.ciLow).toBeGreaterThan(0);
    expect(result.beforeStats).toMatchObject({ method: 'rest_anchored', unit: 'Ah', n: 10 });
    expect((result.beforeStats as { bins: { key: string }[] }).bins.map((b) => b.key).sort()).toEqual(['chg|25', 'dis|25']);
    expect(result.afterStats).toMatchObject({ method: 'rest_anchored', n: 10 });
  });

  it('전·후에서 쓸 수 있는 방식이 다르면 맞비교하지 않고 insufficient_data + 방식별 표본 수를 남긴다', () => {
    // 전은 앵커 용량만, 후는 CC 용량만 있는 세션. 방식을 섞어 비교하면 380 Ah(앵커) → 396 Ah(CC)로
    // 방식 차이가 +16 Ah 개선처럼 보인다 — 같은 방식으로 양쪽이 차지 않으므로 비교하지 않는다.
    const without = (episode: ReturnType<typeof chargeSession>, keys: readonly ('capacity_ah_cc' | 'capacity_ah_soc')[]) => ({
      ...episode,
      features: { ...episode.features, ...Object.fromEntries(keys.map((key) => [key, null])) },
    });
    const mixed = [
      ...[1, 2, 3].map((day) => without(chargeSession({ day, capacityAh: 380 }), ['capacity_ah_cc', 'capacity_ah_soc'])),
      ...[14, 15, 16].map((day) => without(chargeSession({ day, capacityAh: 400, anchored: false }), ['capacity_ah_soc'])),
    ] as StoredEpisode[];
    const result = capacity(mixed);
    expect(result).toMatchObject({ verdict: 'insufficient_data', effect: null });
    expect(result.beforeStats).toMatchObject({
      method: 'capacity_ah_anchored',
      methods: [
        { method: 'capacity_ah_anchored', before: 3, after: 0, matched_bins: 0 },
        { method: 'rest_anchored', before: 0, after: 0, matched_bins: 0 },
        { method: 'capacity_ah_cc', before: 0, after: 3, matched_bins: 0 },
        { method: 'capacity_ah_soc', before: 0, after: 0, matched_bins: 0 },
      ],
    });
  });

  it('P3 지표는 탐지기와 같은 조건 bin·표본 자격 기준을 쓴다 (경계에서 표본을 버린다)', () => {
    const base = { assetId: 7, dq: { completeness: 1, missing_ratio: 0, bad_ratio: 0 }, open: false, valid: true, invalidReason: null } as const;
    const at = (day: number) => ({ start: DAY0 + day * MS_PER_DAY, end: DAY0 + day * MS_PER_DAY + 3_600_000 });
    const bins = (result: ReturnType<typeof beforeAfter>) => (result.beforeStats as { bins: { key: string; median: number }[] }).bins;
    const run = (metric: string, episodes: readonly StoredEpisode[]) =>
      beforeAfter({ assetId: 7, metric, direction: 'decrease', minDelta: 0.01, before, after, episodes, rng: createRng(7), minPerBin: 1, minTotal: 1 });

    // 압축기 비에너지: 이송 질량 1 kg 미만 구간은 버린다 (짧은 이송의 비에너지는 기동 손실이 지배한다)
    const comp = (day: number, massKg: number): StoredEpisode => ({
      ...base,
      ...at(day),
      kind: 'comp.run',
      extractorVersion: 'comp.run@1',
      features: { duration_s: 3600, energy_kwh: 20, mass_kg: massKg, mass_source: 'flow', sec_kwh_per_kg: 20 / massKg, suction_bar: 30, discharge_bar: 300, pressure_ratio: 10, discharge_temp_c: 90, leak_pressure_max_bar: 0.05, vibration_mm_s: null, ambient_c: 21, op_hours_cum: 100 },
      conditions: { ratio_bin: 10, t_bin: 20 },
    });
    expect(bins(run('comp.sec_kwh_per_kg', [comp(1, 4), comp(14, 4)]))).toEqual([{ key: '10|20', n: 1, median: 5 }]);
    expect(run('comp.sec_kwh_per_kg', [comp(1, 0.9), comp(14, 0.9)])).toMatchObject({ verdict: 'insufficient_data' });

    // 블로워 비전력: 유량 bin × 외기 bin
    const blower: StoredEpisode = { ...base, ...at(1), kind: 'fc.blower_run', extractorVersion: 'fc.blower_run@1', features: { duration_s: 3600, flow_kg_h: 620, power_kw: 3.6, specific_w_per_kg_h: 6, ambient_c: 17, op_hours_cum: 5000 }, conditions: { flow_bin: 600, t_bin: 15 } };
    expect(bins(run('fc.blower_specific_power', [blower, { ...blower, ...at(14) }]))).toEqual([{ key: '600|15', n: 1, median: 6 }]);

    // 랙 전류 계단 저항: |ΔI| ≥ 0.1 C이고 SOC 30~70%인 계단만, bin에 샘플 주기를 넣는다
    const step = (day: number, extra: { deltaC?: number; soc?: number } = {}): StoredEpisode => ({
      ...base,
      ...at(day),
      kind: 'ess.current_step',
      extractorVersion: 'ess.current_step@1',
      features: { r_mohm: 5, delta_i_a: 40, delta_i_c: extra.deltaC ?? 0.1, delta_v_v: 0.2, i_before_a: 0, i_after_a: 40, soc: extra.soc ?? 50, t_cell_c: 25, period_s: 60, cell_dv_mv: 6 },
      conditions: { soc_bin: 50, t_bin: 25, direction: 'up' },
    });
    expect(bins(run('ess.resistance_mohm', [step(1), step(14)]))).toEqual([{ key: '60|50|25', n: 1, median: 5 }]);
    expect(run('ess.resistance_mohm', [step(1, { deltaC: 0.09 }), step(14, { deltaC: 0.09 })])).toMatchObject({ verdict: 'insufficient_data' });
    expect(run('ess.resistance_mohm', [step(1, { soc: 70 }), step(14, { soc: 70 })])).toMatchObject({ verdict: 'insufficient_data' });
    expect(run('ess.resistance_mohm', [step(1, { soc: 29 }), step(14, { soc: 29 })])).toMatchObject({ verdict: 'insufficient_data' });

    // 인버터 일 성능지수: 출력제어·클리핑·정지 일과 일사량 1 kWh/m² 미만 일은 버린다
    const day = (offset: number, insolation: number | null, flags: Partial<ReturnType<typeof pvDay>['conditions']> = {}) => {
      const episode = pvDay(7, offset, 4.5, flags);
      return { ...episode, features: { ...episode.features, insolation_kwh_m2: insolation } } as StoredEpisode;
    };
    const pvResult = run('pv.performance_index', [day(1, 5), day(14, 5)]);
    expect(bins(pvResult)).toEqual([{ key: 'all', n: 1, median: 0.9 }]);
    for (const flag of [{ curtailed: true }, { clipping: true }, { stopped: true }]) expect(run('pv.performance_index', [day(1, 5, flag), day(14, 5, flag)])).toMatchObject({ verdict: 'insufficient_data' });
    expect(run('pv.performance_index', [day(1, 0.9), day(14, 0.9)])).toMatchObject({ verdict: 'insufficient_data' });
    expect(run('pv.performance_index', [day(1, null), day(14, null)])).toMatchObject({ verdict: 'insufficient_data' });

    // 연료전지 셀 전압은 fc.steady_run 에피소드에서만 읽는다 (전해조 구간은 표본이 되지 않는다)
    const elRun = { ...elRuns({ count: 2, startHours: 1200, endHours: 1300, rateUvPerH: 0, seed: 1 })[0], assetId: 7, ...at(1) } as StoredEpisode;
    expect(run('fc.v_cell_v', [elRun, { ...elRun, ...at(14) }])).toMatchObject({ verdict: 'insufficient_data' });
  });

  it('지표 정의: 조치 폼이 쓰는 대표 에피소드 종류·이름·단위·좋아지는 방향', () => {
    expect(VERIFICATION_METRICS['ess.capacity_ah']).toMatchObject({ kind: 'ess.charge', label: '랙 유효용량', unit: 'Ah', better: 'increase' });
    expect(VERIFICATION_METRICS['ess.capacity_ah']?.methods.map((m) => m.id)).toEqual(['capacity_ah_anchored', 'rest_anchored', 'capacity_ah_cc', 'capacity_ah_soc']);
    expect(Object.entries(VERIFICATION_METRICS).filter(([key]) => key !== 'ess.capacity_ah').every(([, spec]) => spec.methods.length === 1)).toBe(true);
  });
});
