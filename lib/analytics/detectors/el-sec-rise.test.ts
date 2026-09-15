import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { ElSteadyEpisode } from '../episodes/stack-episodes';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { EL_SEC_RISE_DEFAULTS, elSecRise, type ElSecRiseInput } from './el-sec-rise';
import { H2_KG_PER_AMP_HOUR_PER_CELL } from './hydrogen-eos';
import { DAY0, DQ_FULL } from './test-fixtures';

const DAYS = 150;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const NAMEPLATE = { cellCount: 210, activeAreaCm2: 550, ratedCurrentA: 1100 };
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface Options {
  readonly risePct: number;
  readonly seed: number;
  /** 셀 전압도 같은 비율로 올린다 (스택 열화) */
  readonly voltageFollows?: boolean;
  /** 최근 30일 부분부하(j 0.4) 비중 */
  readonly recentPartialShare?: number;
  readonly faradayDrop?: number;
}

/** 하루 3구간 × 150일. 비에너지는 40~120일 선형 상승 후 유지, 전류밀도 3단 + 부분부하 */
function episodes(o: Options): ElSteadyEpisode[] {
  const rng = createRng(o.seed);
  return Array.from({ length: DAYS * 3 }, (_, i) => {
    const day = i / 3;
    const progress = Math.min(1, Math.max(0, (day - 40) / 80));
    const recent = day >= DAYS - 30;
    const partial = rng.next() < (recent ? (o.recentPartialShare ?? 0.1) : 0.1);
    const j = partial ? 0.42 : [0.82, 1.22, 1.62][i % 3] as number;
    const factor = 1 + (o.risePct / 100) * progress;
    const secBase = partial ? 62 : 50 + 6 * (j - 1.2);
    const sec = secBase * factor * (1 + 0.004 * rng.gaussian());
    const current = j * NAMEPLATE.activeAreaCm2;
    const faraday = 0.97 - (o.faradayDrop ?? 0) * progress;
    const h2 = current * NAMEPLATE.cellCount * H2_KG_PER_AMP_HOUR_PER_CELL * faraday;
    const vCell = (1.75 + 0.2 * (j - 1.2)) * (o.voltageFollows ? factor : 1);
    const start = DAY0 + i * 8 * MS_PER_HOUR;
    return {
      assetId: 31,
      kind: 'el.steady_run',
      extractorVersion: 'el.steady_run@1',
      start,
      end: start + MS_PER_HOUR,
      features: { j_mean: j, i_mean: current, v_cell_mean: vCell, t_stack_mean: 61 + rng.next(), h2_kg: h2, op_hours_cum: 1200 + i * 4, duration_s: 3600, energy_kwh: sec * h2, dc_kwh: sec * h2 * 0.95, sec_kwh_per_kg: sec },
      conditions: { j_bin: 0, t_bin: 60 },
      dq: DQ_FULL,
      open: false,
      valid: true,
      invalidReason: null,
    };
  });
}

const input = (o: Options, extra: Partial<ElSecRiseInput> = {}): ElSecRiseInput => ({ assetId: 31, nameplate: NAMEPLATE, episodes: episodes(o), ...extra });

describe('el.sec_rise@1', () => {
  it('비에너지 +6% 주입을 같은 조건 비교로 6% ± 15% 이내로 복원하고 severity 3, 셀 전압이 그대로면 스택 체크 반박', () => {
    const daily = (fn: (day: number) => number) => Array.from({ length: DAYS }, (_, day) => ({ ts: DAY0 + day * MS_PER_DAY, value: fn(day) }));
    const result = elSecRise.detect(input({ risePct: 6, seed: 2 }, { rectifierEfficiency: daily((d) => (d < 40 ? 96 : 96 - 2 * Math.min(1, (d - 40) / 80))), purgeCounts: daily(() => 10) }), ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'el.sec_rise', failureMode: 'el.system_efficiency_loss', category: 'performance', severity: 3, effect: { metric: 'sec_kwh_per_kg', unit: '%', levelUnit: 'kWh/kg' } });
    expect(finding?.effect.value).toBeGreaterThan(6 * 0.85);
    expect(finding?.effect.value).toBeLessThan(6 * 1.15);
    expect(finding?.effect.ciLow).toBeGreaterThan(0);
    const checks = (finding?.evidence.checks ?? []) as { id: string; status: string }[];
    expect(Object.fromEntries(checks.map((c) => [c.id, c.status]))).toEqual({ stack_voltage: 'refutes', rectifier_efficiency: 'supports', faraday_efficiency: 'refutes', partial_load_share: 'refutes', purge_count: 'refutes' });
    expect(finding?.summary).toContain('kWh/kg');
    expect(JSON.stringify(finding?.evidence).length).toBeLessThan(20_000);
  });

  it('셀 전압이 함께 오르면 스택 열화 동반(category degradation), 패러데이 효율 저하도 지지', () => {
    const result = elSecRise.detect(input({ risePct: 12, seed: 3, voltageFollows: true, faradayDrop: 0.03 }), ctx());
    expect(result.status === 'ok' && result.findings[0]).toMatchObject({ severity: 4, category: 'degradation' });
    const checks = result.status === 'ok' ? ((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]) : [];
    expect(checks.find((c) => c.id === 'stack_voltage')?.status).toBe('supports');
    expect(checks.find((c) => c.id === 'faraday_efficiency')?.status).toBe('supports');
    expect(checks.find((c) => c.id === 'rectifier_efficiency')?.status).toBe('no_data');
  });

  it('대조군: 열화 없음·부분부하 주간(최근 부분부하 비중 60%)은 0건, 부분부하 체크는 지지로 기록된다', () => {
    expect(elSecRise.detect(input({ risePct: 0, seed: 4 }), ctx())).toEqual({ status: 'ok', findings: [] });
    expect(elSecRise.detect(input({ risePct: 0, seed: 5, recentPartialShare: 0.6 }), ctx())).toEqual({ status: 'ok', findings: [] });
    const small = elSecRise.detect(input({ risePct: 2, seed: 6 }), ctx());
    expect(small).toEqual({ status: 'ok', findings: [] });
  });

  it('insufficient: 명판 없음 · break-in 이전뿐 · 표본 부족', () => {
    expect(elSecRise.detect({ ...input({ risePct: 6, seed: 7 }), nameplate: { ...NAMEPLATE, cellCount: 0 } }, ctx()).status).toBe('insufficient');
    const breakIn = elSecRise.detect(input({ risePct: 6, seed: 7 }), ctx({ breakInHours: 50_000 }));
    expect(breakIn.status === 'insufficient' && breakIn.reason).toContain('break-in');
    const few = elSecRise.detect({ ...input({ risePct: 6, seed: 7 }), episodes: episodes({ risePct: 6, seed: 7 }).slice(0, 30) }, ctx());
    expect(few.status === 'insufficient' && few.reason).toContain('표본 부족');
  });

  it('결정성: 같은 입력·시드 → 같은 결과와 input_hash, 기본 파라미터는 스키마 기본값과 같다', () => {
    const a = elSecRise.detect(input({ risePct: 8, seed: 8 }), ctx());
    const b = elSecRise.detect(input({ risePct: 8, seed: 8 }), ctx());
    expect(a).toEqual(b);
    expect(elSecRise.paramSchema.parse({})).toEqual(EL_SEC_RISE_DEFAULTS);
  });
});
