import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { TankHoldPoint } from '../episodes/tank-hold';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../types';
import { ABEL_NOBLE_DEFAULTS, h2DensityKgM3, h2DensityPerBar, h2MassKg } from './hydrogen-eos';
import { fitHold, TANK_STATIC_LEAK_DEFAULTS, tankStaticLeak, type PressureCrossCheck, type TankHoldInput } from './tank-static-leak';
import { DAY0 } from './test-fixtures';

const VOLUME_M3 = 1.85;
const DAYS = 60;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

/** 질량·온도 → 절대압 [bar] (Abel–Noble 역산) */
function pressureOf(massKg: number, tempC: number): number {
  const rho = massKg / VOLUME_M3;
  const { specificGasConstant: rs, coVolume: b } = ABEL_NOBLE_DEFAULTS;
  return (rho * rs * (tempC + 273.15)) / (1 - b * rho) / 1e5;
}

interface HoldOptions {
  readonly leakKgPerDay: (day: number) => number;
  readonly seed: number;
  /** 구간 안 온도 하강 폭 [°C] (야간 냉각) */
  readonly coolingC?: number;
  readonly downstreamRiseBar?: number | null;
  readonly hours?: number;
  readonly count?: number;
}

/** 매일 밤 8시간 정지 보유. 질량은 누설만큼 줄고 온도는 야간에 식는다 (압력은 실기체 상태식으로 역산, 계측 잡음 포함) */
function holds(o: HoldOptions): TankHoldInput[] {
  const rng = createRng(o.seed);
  const hours = o.hours ?? 8;
  let mass = 40;
  return Array.from({ length: o.count ?? DAYS - 1 }, (_, day) => {
    const start = DAY0 + day * MS_PER_DAY + 12 * MS_PER_HOUR;
    const leak = o.leakKgPerDay(day);
    const baseTemp = 18 + 6 * Math.sin(day / 9);
    const points: TankHoldPoint[] = Array.from({ length: hours * 12 }, (_, k) => {
      const t = k * 5 * MS_PER_MINUTE;
      const tempC = baseTemp - (o.coolingC ?? 4) * (1 - Math.exp(-t / (3 * MS_PER_HOUR)));
      const m = mass - (leak * t) / MS_PER_DAY;
      return { ts: start + t, pressureBar: pressureOf(m, tempC) + 0.05 * rng.gaussian(), tempC: tempC + 0.05 * rng.gaussian() };
    });
    mass = mass - leak / 3 + 0.2; // 낮 동안 충전으로 조금씩 채운다
    return { start, end: start + hours * MS_PER_HOUR, completeness: 1, points, downstreamRiseBar: o.downstreamRiseBar ?? 0 };
  });
}

const leakFrom = (day0: number, kg: number) => (day: number) => (day >= day0 ? kg : 0);

describe('수소 Abel–Noble 상태식', () => {
  it('15 °C에서 350 bar ≈ 24 kg/m³, 700 bar ≈ 40 kg/m³ (±7%), 저압은 이상기체에 가깝다', () => {
    expect(Math.abs(h2DensityKgM3(350, 15) / 24 - 1)).toBeLessThan(0.07);
    expect(Math.abs(h2DensityKgM3(700, 15) / 40 - 1)).toBeLessThan(0.07);
    const ideal = 1e5 / (ABEL_NOBLE_DEFAULTS.specificGasConstant * 293.15);
    expect(Math.abs(h2DensityKgM3(1, 20) / ideal - 1)).toBeLessThan(0.001);
    expect(h2DensityKgM3(-3, 20)).toBe(0);
    expect(() => h2DensityKgM3(100, -300)).toThrow(RangeError);
  });

  it('질량·압력 미분이 수치 미분과 같다', () => {
    const numeric = (h2MassKg(300.01, 20, 1) - h2MassKg(299.99, 20, 1)) / 0.02;
    expect(h2DensityPerBar(300, 20)).toBeCloseTo(numeric, 6);
  });
});

describe('tank.static_leak@1', () => {
  it('미세 누설 0.3 kg/일 주입을 ±15% 이내로 복원하고 performance severity 3 "현장 점검 권고", 온도 체크는 반박', () => {
    const result = tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: leakFrom(40, 0.3), seed: 2 }) }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'tank.static_leak', failureMode: 'h2.storage_leak', category: 'performance', severity: 3, effect: { unit: 'kg/일', metric: 'tank_leak_kg_per_day' } });
    expect(finding?.effect.value).toBeGreaterThan(0.3 * 0.85);
    expect(finding?.effect.value).toBeLessThan(0.3 * 1.15);
    expect(finding?.title).toContain('현장 점검 권고');
    expect(finding?.summary).toContain('대체하지 않습니다');
    const checks = Object.fromEntries(((finding?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(checks).toEqual({ temperature_compensation: 'refutes', pressure_drift: 'no_data', valve_passing: 'refutes', hold_sufficiency: 'refutes' });
    const evidence = finding?.evidence as { representative: { points: unknown[] }; holds: unknown[] };
    expect(evidence.representative.points.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(finding?.evidence).length).toBeLessThan(20_000);
  });

  it('누설률 CI 하한이 안전 기준(0.5 kg/일)을 넘을 때만 safety severity 4', () => {
    const result = tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: leakFrom(40, 1.5), seed: 3 }) }, ctx());
    expect(result.status === 'ok' && result.findings[0]).toMatchObject({ category: 'safety', severity: 4 });
    const value = result.status === 'ok' ? (result.findings[0]?.effect.value ?? 0) : 0;
    expect(Math.abs(value / 1.5 - 1)).toBeLessThan(0.15);
    const raised = tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: leakFrom(40, 1.5), seed: 3 }) }, ctx({ safetyKgPerDay: 5 }));
    expect(raised.status === 'ok' && raised.findings[0]).toMatchObject({ category: 'performance', severity: 3 });
  });

  it('대조군: 누설 없이 일교차(야간 12 °C 냉각)가 커도 온도 보정으로 0건', () => {
    expect(tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: () => 0, seed: 4, coolingC: 12 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
    expect(tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: () => 0, seed: 5 }) }, ctx())).toEqual({ status: 'ok', findings: [] });
  });

  it('하류 압력 상승·비교 압력 차이 감소가 있으면 밸브 통과 누설·압력 센서 드리프트 체크를 지지로 기록한다', () => {
    const cross: PressureCrossCheck[] = Array.from({ length: 20 }, (_, i) => ({ ts: DAY0 + (40 + i) * MS_PER_DAY, offsetBar: -2 * i, source: 'peer_tank' }));
    const result = tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: leakFrom(40, 0.3), seed: 6, downstreamRiseBar: 2 }), pressureCrossChecks: cross }, ctx());
    const checks = result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {};
    expect(checks).toMatchObject({ valve_passing: 'supports', pressure_drift: 'supports' });
  });

  it('insufficient: 내용적 없음 · 짧은 구간뿐 · 구간 수 부족, 결정성과 스키마 기본값', () => {
    const base = { assetId: 77, waterVolumeL: 1850 };
    expect(tankStaticLeak.detect({ ...base, waterVolumeL: 0, holds: [] }, ctx()).status).toBe('insufficient');
    const short = tankStaticLeak.detect({ ...base, holds: holds({ leakKgPerDay: () => 0.3, seed: 7, hours: 2 }) }, ctx());
    expect(short.status === 'insufficient' && short.reason).toContain('정지 보유 구간 부족');
    expect(tankStaticLeak.detect({ ...base, holds: holds({ leakKgPerDay: () => 0.3, seed: 7, count: 6 }) }, ctx()).status).toBe('insufficient');
    const input = { ...base, holds: holds({ leakKgPerDay: leakFrom(40, 0.4), seed: 8 }) };
    expect(tankStaticLeak.detect(input, ctx())).toEqual(tankStaticLeak.detect(input, ctx()));
    expect(tankStaticLeak.paramSchema.parse({})).toEqual(TANK_STATIC_LEAK_DEFAULTS);
    expect(fitHold({ start: 0, end: 5 * MS_PER_HOUR, completeness: 1, points: [], downstreamRiseBar: null }, VOLUME_M3, ABEL_NOBLE_DEFAULTS, TANK_STATIC_LEAK_DEFAULTS)).toBeNull();
  });
});
