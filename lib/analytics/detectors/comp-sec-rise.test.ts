import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { CompRunEpisode } from '../episodes/compressor';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { COMP_SEC_RISE_DEFAULTS, compSecRise } from './comp-sec-rise';
import { DAY0, DQ_FULL } from './test-fixtures';

const DAYS = 150;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface Options {
  readonly risePct: number;
  readonly seed: number;
  readonly dischargeRiseC?: number;
  readonly leakRiseBar?: number;
  /** 최근 30일 외기 온도 상승 (계절 편중) */
  readonly recentHotC?: number;
  /** 이송량이 적은 짧은 운전 비율 (기동 과도로 비에너지가 크다) */
  readonly shortRunShare?: number;
}

/** 하루 3회 운전 × 150일. 비에너지는 40~120일 선형 상승 후 유지, 압력비 4단 */
function runs(o: Options): CompRunEpisode[] {
  const rng = createRng(o.seed);
  return Array.from({ length: DAYS * 3 }, (_, i) => {
    const day = i / 3;
    const progress = Math.min(1, Math.max(0, (day - 40) / 80));
    const recent = day >= DAYS - 30;
    const ratio = [8.5, 10.5, 12.5, 14.5][i % 4] as number;
    const ambient = 18 + rng.next() * 2 + (recent ? (o.recentHotC ?? 0) : 0);
    const short = rng.next() < (o.shortRunShare ?? 0);
    const secBase = (2 + 0.15 * (ratio - 10)) * (1 + 0.004 * (ambient - 19));
    const sec = secBase * (1 + (o.risePct / 100) * progress) * (1 + 0.005 * rng.gaussian()) * (short ? 3 : 1);
    const mass = short ? 0.4 : 7.5;
    const start = DAY0 + i * 8 * MS_PER_HOUR;
    return {
      assetId: 55,
      kind: 'comp.run',
      extractorVersion: 'comp.run@1',
      start,
      end: start + 2 * MS_PER_HOUR,
      features: {
        duration_s: 7200,
        energy_kwh: sec * mass,
        mass_kg: mass,
        mass_source: 'flow',
        sec_kwh_per_kg: sec,
        suction_bar: 30,
        discharge_bar: 30 * ratio,
        pressure_ratio: ratio,
        discharge_temp_c: 60 + 12 * Math.log(ratio) + (o.dischargeRiseC ?? 0) * progress + 0.3 * rng.gaussian(),
        leak_pressure_max_bar: 0.05 + (o.leakRiseBar ?? 0) * progress,
        vibration_mm_s: null,
        ambient_c: ambient,
        op_hours_cum: 2000 + i * 2,
      },
      conditions: { ratio_bin: 0, t_bin: 15 },
      dq: DQ_FULL,
      open: false,
      valid: true,
      invalidReason: null,
    };
  });
}

const checksOf = (result: ReturnType<typeof compSecRise.detect>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('comp.sec_rise@1', () => {
  it('압축기 비에너지 +12% 주입을 같은 압력비·외기 조건으로 12% ± 15% 복원, severity 3, 체크 기록', () => {
    const result = compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 12, seed: 2 }) }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'comp.sec_rise', failureMode: 'comp.efficiency_loss', category: 'performance', severity: 3, effect: { metric: 'comp_sec_kwh_per_kg', unit: '%', levelUnit: 'kWh/kg' } });
    expect(finding?.effect.value).toBeGreaterThan(12 * 0.85);
    expect(finding?.effect.value).toBeLessThan(12 * 1.15);
    expect(checksOf(result)).toEqual({ discharge_temp: 'refutes', leak_pressure: 'refutes', vibration: 'no_data', cooling: 'refutes' });
  });

  it('토출 온도·누설 감지 압력이 함께 오르면 지지 — 누설 감지 압력은 safety finding이 아니라 체크와 권고 문구만', () => {
    const result = compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 25, seed: 3, dischargeRiseC: 9, leakRiseBar: 0.8 }) }, ctx());
    expect(result.status === 'ok' && result.findings).toHaveLength(1);
    const [finding] = result.status === 'ok' ? result.findings : [];
    expect(finding).toMatchObject({ severity: 4, category: 'performance' });
    expect(checksOf(result)).toMatchObject({ discharge_temp: 'supports', leak_pressure: 'supports' });
    const leak = ((finding?.evidence.checks ?? []) as { id: string; note: string }[]).find((c) => c.id === 'leak_pressure');
    expect(leak?.note).toContain('인터록 판단을 대체하지 않습니다');
  });

  it('대조군: 열화 없음 · 최근 고온 편중(외기 +8 °C) · 짧은 운전 섞임은 0건', () => {
    expect(compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 0, seed: 4 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
    expect(compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 0, seed: 5, recentHotC: 8 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
    expect(compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 0, seed: 6, shortRunShare: 0.3 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
  });

  it('insufficient: 운전 없음 · 표본 부족, 결정성·스키마 기본값', () => {
    expect(compSecRise.detect({ assetId: 55, episodes: [] }, ctx()).status).toBe('insufficient');
    const few = compSecRise.detect({ assetId: 55, episodes: runs({ risePct: 12, seed: 7 }).slice(0, 40) }, ctx());
    expect(few.status === 'insufficient' && few.reason).toContain('표본 부족');
    const input = { assetId: 55, episodes: runs({ risePct: 15, seed: 8 }) };
    expect(compSecRise.detect(input, ctx())).toEqual(compSecRise.detect(input, ctx()));
    expect(compSecRise.paramSchema.parse({})).toEqual(COMP_SEC_RISE_DEFAULTS);
  });
});
