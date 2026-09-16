import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { FcBlowerRunEpisode } from '../episodes/fc-blower';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { FC_BLOWER_WEAR_DEFAULTS, fcBlowerWear, type FcBlowerWearInput } from './fc-blower-wear';
import { DAY0, DQ_FULL, fcRuns } from './test-fixtures';
import type { AssetEventInput } from './types';

const DAYS = 150;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface Options {
  readonly wearPct: number;
  readonly seed: number;
  /** 최근 30일 외기 온도 상승 (고온 편중) */
  readonly recentHotC?: number;
  /** 이 날 필터 교체로 비전력이 이만큼 [%] 회복 */
  readonly filterRecovery?: { readonly day: number; readonly pct: number };
}

/** 하루 4구간 × 150일. 블로워 전력 = 기저 + k·Q³ (마모만큼 증가), 유량 300~800 kg/h 무작위 */
function runs(o: Options): FcBlowerRunEpisode[] {
  const rng = createRng(o.seed);
  return Array.from({ length: DAYS * 4 }, (_, i) => {
    const day = i / 4;
    const progress = Math.min(1, Math.max(0, (day - 40) / 80));
    const recovered = o.filterRecovery && day >= o.filterRecovery.day ? o.filterRecovery.pct : 0;
    const flow = 300 + 500 * rng.next();
    const ambient = 15 + 3 * rng.next() + (day >= DAYS - 30 ? (o.recentHotC ?? 0) : 0);
    const density = 1 + 0.003 * (ambient - 16);
    const power = (0.3 + 10.5 * (flow / 850) ** 3) * density * (1 + ((o.wearPct - recovered) / 100) * progress) * (1 + 0.01 * rng.gaussian());
    const start = DAY0 + i * 6 * MS_PER_HOUR;
    return {
      assetId: 61,
      kind: 'fc.blower_run',
      extractorVersion: 'fc.blower_run@1',
      start,
      end: start + MS_PER_HOUR,
      features: { duration_s: 3600, flow_kg_h: flow, power_kw: power, specific_w_per_kg_h: (power * 1000) / flow, ambient_c: ambient, op_hours_cum: 3000 + i },
      conditions: { flow_bin: 0, t_bin: 15 },
      dq: DQ_FULL,
      open: false,
      valid: true,
      invalidReason: null,
    };
  });
}

const filterEvent = (day: number): AssetEventInput => ({ ts: DAY0 + day * MS_PER_DAY, kind: 'maintenance', resetsBaseline: false, note: '흡입 에어필터 교체' });
const run = (input: Partial<FcBlowerWearInput> & { runs: readonly FcBlowerRunEpisode[] }, params = {}) => fcBlowerWear.detect({ assetId: 61, events: [], ...input }, ctx(params));
const checksOf = (result: ReturnType<typeof run>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('fc.blower_wear@1', () => {
  it('블로워 비전력 +25% 주입을 같은 유량·외기 조건으로 25% ± 15% 복원, severity 3 degradation', () => {
    const stack = fcRuns({ count: 600, startHours: 3000, endHours: 3600, rateUvPerH: 0, seed: 1 }).map((e, i) => ({ ...e, start: DAY0 + i * 6 * MS_PER_HOUR, features: { ...e.features, v_cell_at_jref: 0.8 + 0.0002 * Math.sin(i) } }));
    const result = run({ runs: runs({ wearPct: 25, seed: 2 }), stackEpisodes: stack });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'fc.blower_wear', failureMode: 'fc.blower_wear', category: 'degradation', severity: 3, effect: { metric: 'blower_specific_power', unit: '%', levelUnit: 'W/(kg/h)' } });
    expect(finding?.effect.value).toBeGreaterThan(25 * 0.85);
    expect(finding?.effect.value).toBeLessThan(25 * 1.15);
    expect(checksOf(result)).toEqual({ air_filter: 'no_data', bearing_impeller: 'no_data', air_density: 'refutes', stack_voltage: 'refutes' });
  });

  it('필터 교체 이력: 교체 뒤 회복했으면 필터 막힘 지지(창 안 교체 포함), 교체에도 회복이 없으면 필터 반박·베어링 임펠러 지지', () => {
    const history = runs({ wearPct: 30, seed: 3, filterRecovery: { day: 20, pct: 0 } });
    const pastRecovery = history.map((e) => (e.start < DAY0 + 12 * MS_PER_DAY ? { ...e, features: { ...e.features, specific_w_per_kg_h: (e.features.specific_w_per_kg_h ?? 0) * 1.1 } } : e));
    const clogged = run({ runs: pastRecovery, events: [filterEvent(12)] }, { referencePerBin: 5 });
    expect(checksOf(clogged).air_filter).toBe('supports');
    const worn = run({ runs: runs({ wearPct: 30, seed: 4 }), events: [filterEvent(130)] });
    expect(checksOf(worn)).toMatchObject({ bearing_impeller: 'supports', air_filter: 'refutes' });
    // 상승 이후(기준 기간 밖) 교체로 회복된 경우도 필터 막힘 근거로 본다
    const helped = run({ runs: runs({ wearPct: 40, seed: 5, filterRecovery: { day: 130, pct: 25 } }), events: [filterEvent(130)] });
    expect(checksOf(helped)).toMatchObject({ bearing_impeller: 'refutes', air_filter: 'supports' });
  });

  it('대조군: 마모 없음 · 최근 고온 편중(+10 °C)은 0건', () => {
    expect(run({ runs: runs({ wearPct: 0, seed: 6 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ runs: runs({ wearPct: 0, seed: 7, recentHotC: 10 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ runs: runs({ wearPct: 5, seed: 8 }) })).toEqual({ status: 'ok', findings: [] });
  });

  it('insufficient·결정성·스키마 기본값·유량 보정 끄기', () => {
    expect(run({ runs: [] }).status).toBe('insufficient');
    const few = run({ runs: runs({ wearPct: 25, seed: 9 }).slice(0, 30) });
    expect(few.status === 'insufficient' && few.reason).toContain('표본 부족');
    const input = runs({ wearPct: 25, seed: 10 });
    expect(run({ runs: input })).toEqual(run({ runs: input }));
    expect(run({ runs: input }, { affinityExponent: 0 }).status).toBe('ok');
    expect(fcBlowerWear.paramSchema.parse({})).toEqual(FC_BLOWER_WEAR_DEFAULTS);
  });
});
