import { describe, expect, it } from 'vitest';
import { MS_PER_MINUTE } from '../types';
import { extractElStarts, extractElSteadyRuns, extractFcStarts, extractFcSteadyRuns } from './stack-episodes';
import { stackProfile, T0 } from './test-fixtures';

const EL = { cell_count: 210, active_area_cm2: 550, rated_current_a: 1100 };
const FC = { cell_count: 400, active_area_cm2: 800, rated_current_a: 820 };

// 꺼짐 30분 → 550 A 120분 → 880 A 60분 → 꺼짐 20분 → 550 A 30분 → 꺼짐 30분
const PROFILE = [
  { minutes: 30, currentA: 0 },
  { minutes: 120, currentA: 550 },
  { minutes: 60, currentA: 880 },
  { minutes: 20, currentA: 0 },
  { minutes: 30, currentA: 550 },
  { minutes: 30, currentA: 0 },
];
const WINDOW = { start: T0, end: T0 + 290 * MS_PER_MINUTE };

describe('el.steady_run@1 / el.start@1', () => {
  const series = stackProfile(T0, PROFILE, { cells: 210, areaCm2: 550, startHours: 2000 });
  const input = { assetId: 11, window: WINDOW, series, nameplate: EL };

  it('전류 ±5% 10분 이상 유지 구간을 정상운전으로 뽑고 특징을 계산한다', () => {
    const runs = extractElSteadyRuns(input);
    expect(runs.map((r) => r.features.duration_s)).toEqual([7200, 3600, 1800]);
    const [first] = runs;
    expect(first?.extractorVersion).toBe('el.steady_run@1');
    expect(first?.features.j_mean).toBeCloseTo(1, 9);
    expect(first?.features.v_cell_mean).toBeCloseTo(1.8, 9);
    expect(first?.features.t_stack_mean).toBe(62);
    expect(first?.features.h2_kg).toBeCloseTo(18, 3);
    expect(first?.features.energy_kwh).toBeCloseTo(900, 3);
    expect(first?.features.sec_kwh_per_kg).toBeCloseTo(50, 3);
    expect(first?.features.dc_kwh).toBeCloseTo((550 * 210 * 1.8 * 2) / 1000, 3);
    expect(first?.features.op_hours_cum).toBeGreaterThan(2000);
    expect(first?.conditions).toEqual({ j_bin: 1, t_bin: 60 });
    expect(first).toMatchObject({ open: false, valid: true });
    expect(runs[1]?.conditions.j_bin).toBe(1.6);
  });

  it('창 끝까지 이어진 정상운전은 open', () => {
    const cut = extractElSteadyRuns({ ...input, window: { start: T0, end: T0 + 100 * MS_PER_MINUTE } });
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ open: true, valid: false, invalidReason: 'open' });
  });

  it('기동: 창 시작부터 꺼져 있던 첫 기동은 꺼짐 시간 모름, 20분 꺼짐 뒤 재기동은 온간', () => {
    const starts = extractElStarts(input);
    expect(starts).toHaveLength(2);
    expect(starts[0]?.features).toEqual({ off_duration_s: null, time_to_steady_s: 0, start_count_delta: 0 });
    expect(starts[0]?.conditions.cold).toBeNull();
    expect(starts[1]?.features.off_duration_s).toBe(21 * 60);
    expect(starts[1]?.conditions.cold).toBe(false);
    expect(starts[1]?.end).toBeGreaterThan(starts[1]?.start ?? 0);
  });

  it('짧은 정지(10분 미만)는 기동으로 세지 않고 명판 오류는 예외', () => {
    const short = stackProfile(T0, [{ minutes: 15, currentA: 0 }, { minutes: 30, currentA: 550 }, { minutes: 5, currentA: 0 }, { minutes: 30, currentA: 550 }], { cells: 210, areaCm2: 550, startHours: 10 });
    expect(extractElStarts({ ...input, series: short })).toHaveLength(1);
    expect(() => extractElSteadyRuns({ ...input, nameplate: { ...EL, cell_count: 0 } })).toThrow(RangeError);
  });
});

describe('fc.steady_run@1 / fc.start@1', () => {
  const series = stackProfile(T0, PROFILE, { cells: 400, areaCm2: 800, startHours: 5000 });
  const input = { assetId: 21, window: WINDOW, series, nameplate: FC };

  it('기준 전류밀도 환산 전압·kg/MWh·블로워 전력', () => {
    const runs = extractFcSteadyRuns(input);
    const first = runs[0];
    // j = 550/800 = 0.6875, v = 1.6 + 0.2·j, 환산 = v + 0.25·(j − 0.5)
    expect(first?.features.j_mean).toBeCloseTo(0.6875, 9);
    expect(first?.features.v_cell_at_jref).toBeCloseTo(1.6 + 0.2 * 0.6875 + 0.25 * 0.1875, 6);
    expect(first?.features.h2_kg).toBeCloseTo(24, 3);
    expect(first?.features.ac_kwh).toBeCloseTo(400, 3);
    expect(first?.features.kg_per_mwh).toBeCloseTo(60, 3);
    expect(first?.features.blower_power_mean).toBe(6);
    // j = 880/800 = 1.1 → 기준에서 너무 멀어 환산하지 않는다
    expect(runs[1]?.features.v_cell_at_jref).toBeNull();
    expect(extractFcStarts(input).map((s) => s.kind)).toEqual(['fc.start', 'fc.start']);
  });
});
