import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { TankHoldPoint } from '../episodes/tank-hold';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../types';
import { ABEL_NOBLE_DEFAULTS, h2DensityKgM3, h2DensityPerBar, h2Eos, h2MassKg, LEMMON_EOS } from './hydrogen-eos';
import type { PressureCrossCheck } from './tank-peer-pressure';
import { fitHold, TANK_STATIC_LEAK_DEFAULTS, tankStaticLeak, type TankHoldInput } from './tank-static-leak';
import { DAY0 } from './test-fixtures';

const VOLUME_M3 = 1.85;
const DAYS = 60;
const NOW = DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

/** 질량·온도 → 절대압 [bar] (탐지기 기본 상태식 NIST Lemmon 2008 역산) */
const pressureOf = (massKg: number, tempC: number): number => LEMMON_EOS.pressure(massKg, tempC, VOLUME_M3);

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

// ── 누설 0 합성 정지 보유 구간 (검정 크기 측정용) ───────────────────────────
/** 기준 12 + 최근 6구간 */
const QUIET_HOLDS = 18;
const QUIET_POINTS = 24;
const QUIET_NOW = DAY0 + QUIET_HOLDS * MS_PER_DAY;

/** 구간마다 남는 겉보기 손실률(온도 보정 잔차·센서 열지연)의 표준편차 [kg/일]. 평균은 0 = 실제 누설 없음 */
const QUIET_HOLD_SIGMA = 0.08;

/**
 * 누설이 없는 정지 보유 구간 세트. 참 누설률은 0이고 두 가지 잡음만 있다.
 *   ① 압력·온도 계측 잡음 (구간 안 기울기 불확실도)
 *   ② 구간마다 다른 겉보기 손실률 N(0, QUIET_HOLD_SIGMA) — 온도 보정 잔차·센서 열지연처럼 구간 사이에 남는 산포.
 * ②가 기준 구간에서 σ로 추정되는 값이고, 검정 통계량의 표준오차는 이 σ와 기준·최근 구간 수로 결정된다.
 */
function quietHolds(seed: number, leakKgPerDay = 0): TankHoldInput[] {
  const rng = createRng(seed);
  const hours = 8;
  return Array.from({ length: QUIET_HOLDS }, (_, day) => {
    const start = DAY0 + day * MS_PER_DAY + 12 * MS_PER_HOUR;
    const mass0 = 40 + 0.5 * rng.gaussian();
    // 최근 구간(기준 12개 뒤)에만 참 누설을 넣는다
    const apparentLoss = QUIET_HOLD_SIGMA * rng.gaussian() + (day >= 12 ? leakKgPerDay : 0);
    const baseTemp = 18 + 6 * Math.sin(day / 9);
    const points: TankHoldPoint[] = Array.from({ length: QUIET_POINTS }, (_, k) => {
      const t = (k * hours * MS_PER_HOUR) / QUIET_POINTS;
      const tempC = baseTemp - 4 * (1 - Math.exp(-t / (3 * MS_PER_HOUR)));
      const mass = mass0 - (apparentLoss * t) / MS_PER_DAY;
      return { ts: start + t, pressureBar: pressureOf(mass, tempC) + 0.05 * rng.gaussian(), tempC: tempC + 0.05 * rng.gaussian() };
    });
    return { start, end: start + hours * MS_PER_HOUR, completeness: 1, points, downstreamRiseBar: 0 };
  });
}

/** 구간 세트 trials개 중 finding이 나온 비율 (누설 0이면 검정의 실제 크기, 누설을 넣으면 검출력) */
function significanceRate(trials: number, leakKgPerDay = 0): number {
  let significant = 0;
  for (let i = 0; i < trials; i += 1) {
    const result = tankStaticLeak.detect({ assetId: 1, waterVolumeL: 1850, holds: quietHolds(9_000 + i, leakKgPerDay) }, { now: QUIET_NOW, rng: createRng(31_000 + i), params: { iterations: 200 } });
    if (result.status === 'ok' && result.findings.length > 0) significant += 1;
  }
  return significant / trials;
}

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
    expect(checks).toEqual({ temperature_compensation: 'refutes', peer_pressure: 'no_data', valve_passing: 'refutes', hold_sufficiency: 'refutes' });
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

  it('하류 압력 상승이면 밸브 통과 누설 지지, 뱅크 교차 확인은 이 용기만 떨어질 때 지지·함께 떨어질 때 반박', () => {
    /** 정지 구간마다 비교 대상(같은 뱅크 다른 용기) 압력 기울기 */
    const cross = (slopeBarPerDay: number): PressureCrossCheck[] => Array.from({ length: DAYS - 1 }, (_, day) => ({ holdStart: DAY0 + day * MS_PER_DAY + 12 * MS_PER_HOUR, slopeBarPerDay, source: 'peer_tank' as const, n: 3 }));
    const run = (crossChecks: PressureCrossCheck[] | undefined) => {
      const result = tankStaticLeak.detect({ assetId: 77, waterVolumeL: 1850, holds: holds({ leakKgPerDay: leakFrom(40, 0.3), seed: 6, downstreamRiseBar: 2 }), pressureCrossChecks: crossChecks }, ctx());
      return result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {};
    };
    // 비교 대상 압력이 그대로면(기울기 0) 이 용기 압력 하강분 전부가 이 용기 몫 → 지지, 비교 대상이 훨씬 빨리 떨어지면 반박
    expect(run(cross(0))).toMatchObject({ valve_passing: 'supports', peer_pressure: 'supports' });
    expect(run(cross(-30))).toMatchObject({ peer_pressure: 'refutes' });
    expect(run(undefined)).toMatchObject({ peer_pressure: 'no_data' });
  });

  // 표준오차 정정 전 2.1%(21/1000) → 정정 후 0.8%. 명목은 zSigma 3σ 한쪽 검정이므로 0.135%이고, 남는 차이는 기준 12구간 MAD로 σ를 재는 표본오차다.
  it('누설 0인 합성 정지 구간 1000회에서 유의 판정 비율이 명목 5% + 여유 이내이고, 실제 누설 0.4 kg/일은 검출한다', { timeout: 180_000 }, () => {
    expect(significanceRate(1000)).toBeLessThanOrEqual(0.06);
    expect(significanceRate(200, 0.4)).toBeGreaterThanOrEqual(0.9);
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
    expect(fitHold({ start: 0, end: 5 * MS_PER_HOUR, completeness: 1, points: [], downstreamRiseBar: null }, VOLUME_M3, LEMMON_EOS, TANK_STATIC_LEAK_DEFAULTS)).toBeNull();
    expect(h2Eos('abel_noble').mass(300, 20, 1)).toBeCloseTo(h2MassKg(300, 20, 1), 12);
    expect(h2Eos('abel_noble').densityPerBar(300, 20)).toBeCloseTo(h2DensityPerBar(300, 20), 12);
  });
});
