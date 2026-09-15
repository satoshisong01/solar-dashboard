import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { EssStepEpisode } from '../episodes/ess-steps';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { ESS_RESISTANCE_DEFAULTS, essResistanceGrowth, type EssResistanceInput } from './ess-resistance-growth';
import { DAY0 } from './test-fixtures';

const DAYS = 150;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface Options {
  readonly growthPct: number;
  readonly seed: number;
  /** 셀 전압 편차도 함께 커짐 [mV] */
  readonly dvRiseMv?: number;
  /** 최근 30일 셀 온도 하강 (한파) — 저온 bin 저항이 원래 높다 */
  readonly recentColdC?: number;
  /** 이 날부터 샘플 주기 변경 */
  readonly periodChange?: { readonly day: number; readonly periodS: number };
}

/** 하루 6계단 × 150일. R = 기저(온도 의존) × (1 + 증가율·진행도), SOC 20~80% 무작위 */
function steps(o: Options): EssStepEpisode[] {
  const rng = createRng(o.seed);
  return Array.from({ length: DAYS * 6 }, (_, i) => {
    const day = i / 6;
    const progress = Math.min(1, Math.max(0, (day - 40) / 80));
    const temp = 24 + 2 * rng.next() - (day >= DAYS - 30 ? (o.recentColdC ?? 0) : 0);
    const soc = 20 + 60 * rng.next();
    const period = o.periodChange && day >= o.periodChange.day ? o.periodChange.periodS : 60;
    const base = 48 * (1 + 0.02 * (25 - temp)) * (period === 60 ? 1 : 0.8);
    const rMohm = base * (1 + (o.growthPct / 100) * progress) * (1 + 0.015 * rng.gaussian());
    const deltaI = (rng.next() < 0.5 ? 1 : -1) * (80 + 40 * rng.next());
    const start = DAY0 + i * 4 * MS_PER_HOUR;
    return {
      assetId: 9,
      kind: 'ess.current_step',
      extractorVersion: 'ess.current_step@1',
      start,
      end: start + period * 1000,
      features: { r_mohm: rMohm, delta_i_a: deltaI, delta_i_c: deltaI / 600, delta_v_v: (deltaI * rMohm) / 1000, i_before_a: 0, i_after_a: deltaI, soc, t_cell_c: temp, period_s: period, cell_dv_mv: 8 + (o.dvRiseMv ?? 0) * progress },
      conditions: { soc_bin: 0, t_bin: 20, direction: deltaI > 0 ? 'up' : 'down' },
      dq: { completeness: 1, missing_ratio: 0, bad_ratio: 0 },
      open: false,
      valid: true,
      invalidReason: null,
    };
  });
}

const run = (input: Partial<EssResistanceInput> & { steps: readonly EssStepEpisode[] }, params = {}) => essResistanceGrowth.detect({ assetId: 9, ...input }, ctx(params));
const checksOf = (result: ReturnType<typeof run>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('ess.resistance_growth@1', () => {
  it('R_60s +30% 주입을 SOC 10~90%·온도 bin 비교로 30% ± 15% 복원, severity 2, 접속부 체크 지지', () => {
    const result = run({ steps: steps({ growthPct: 30, seed: 2 }), capacityFade: { effectPct: -0.2, ciHighPct: 0.5 } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'ess.resistance_growth', failureMode: 'ess.resistance_growth', category: 'degradation', severity: 2, effect: { metric: 'R_60s', unit: '%', levelUnit: 'mΩ' } });
    expect(finding?.effect.value).toBeGreaterThan(30 * 0.85);
    expect(finding?.effect.value).toBeLessThan(30 * 1.15);
    expect(finding?.title).toContain('R_60s');
    expect(checksOf(result)).toEqual({ cold: 'refutes', connection_resistance: 'supports', capacity_fade: 'refutes', sample_period: 'refutes' });
  });

  it('셀 편차 증가·용량 감소 동반이면 접속부 반박·용량 지지, 샘플 주기가 바뀌면 최근 주기만 비교하고 체크에 남긴다', () => {
    const cell = run({ steps: steps({ growthPct: 50, seed: 3, dvRiseMv: 15 }), capacityFade: { effectPct: -6, ciHighPct: -4 } });
    expect(cell.status === 'ok' && cell.findings[0]?.severity).toBe(3);
    expect(checksOf(cell)).toMatchObject({ connection_resistance: 'refutes', capacity_fade: 'supports' });
    const changed = run({ steps: steps({ growthPct: 0, seed: 4, periodChange: { day: 20, periodS: 10 } }) });
    expect(changed).toEqual({ status: 'ok', findings: [] });
    const grown = run({ steps: steps({ growthPct: 45, seed: 5, periodChange: { day: 20, periodS: 10 } }) });
    expect(grown.status === 'ok' && grown.findings[0]?.effect.metric).toBe('R_10s');
    expect(checksOf(grown).sample_period).toBe('supports');
  });

  it('대조군: 증가 없음 · 한파 주간(최근 셀 온도 −8 °C, 저온 저항 상승)은 0건', () => {
    expect(run({ steps: steps({ growthPct: 0, seed: 6 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ steps: steps({ growthPct: 0, seed: 7, recentColdC: 8 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ steps: steps({ growthPct: 10, seed: 8 }) })).toEqual({ status: 'ok', findings: [] });
  });

  it('insufficient·결정성·스키마 기본값', () => {
    expect(run({ steps: [] }).status).toBe('insufficient');
    const few = run({ steps: steps({ growthPct: 30, seed: 9 }).slice(0, 60) });
    expect(few.status === 'insufficient' && few.reason).toContain('표본 부족');
    const input = steps({ growthPct: 30, seed: 10 });
    expect(run({ steps: input })).toEqual(run({ steps: input }));
    expect(essResistanceGrowth.paramSchema.parse({})).toEqual(ESS_RESISTANCE_DEFAULTS);
  });
});
