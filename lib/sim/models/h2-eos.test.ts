import { describe, expect, it } from 'vitest';
import { H2_MOLAR_MASS_KG_PER_MOL } from './common';
import { h2MassKg, h2PressureBar, plcH2MassKg, trueCompressibility } from './h2-eos';

/** NIST Lemmon·Huber·Leachman 2008 수소 Z(T, P) — 참값 상태식이 실기체 수준인지 확인하는 기준 */
function lemmonZ(tempC: number, pressureBar: number): number {
  const a = [0.0588846, -0.06136111, -0.002650473, 0.002731125, 0.001802374, -0.001150707, 0.9588528e-4, -0.110904e-6, 0.1264403e-9];
  const b = [1.325, 1.87, 2.5, 2.8, 2.938, 3.14, 3.37, 3.75, 4.0];
  const c = [1.0, 1.0, 2.0, 2.0, 2.42, 2.63, 3.0, 4.0, 5.0];
  const t = tempC + 273.15;
  return 1 + a.reduce((sum, ai, i) => sum + ai * (100 / t) ** (b[i] ?? 0) * (pressureBar / 10) ** (c[i] ?? 0), 0);
}

/** 분석 쪽(lib/analytics) Abel–Noble 질량 [kg]: ρ = P / (R_s·T + b·P), b = 7.69e-3 m³/kg */
const abelNobleMassKg = (pressureBar: number, volumeM3: number, tempC: number): number => {
  const p = pressureBar * 1e5;
  return (p / (4124.2 * (tempC + 273.15) + 7.69e-3 * p)) * volumeM3;
};

const zOf = (pressureBar: number, tempC: number): number => {
  const molarDensity = h2MassKg(pressureBar, 1, tempC) / H2_MOLAR_MASS_KG_PER_MOL;
  return trueCompressibility(molarDensity, tempC);
};

describe('수소 참값 상태식 (비리얼 B(T)·C)', () => {
  it('압력 ↔ 질량 변환이 서로 역함수다', () => {
    for (const tempC of [-10, 15, 45]) {
      for (const bar of [1, 30, 100, 250, 450]) expect(h2PressureBar(h2MassKg(bar, 1.85, tempC), 1.85, tempC)).toBeCloseTo(bar, 9);
    }
  });

  it('NIST 기준식과 Z 편차 0.4% 이내 (−10~50 °C, 10~450 bar), 기준 검증점 300 K·10 MPa Z = 1.0599', () => {
    expect(lemmonZ(26.85, 100)).toBeCloseTo(1.05985282, 7);
    for (const tempC of [-10, 20, 50]) {
      for (const bar of [10, 100, 300, 450]) expect(Math.abs(zOf(bar, tempC) / lemmonZ(tempC, bar) - 1)).toBeLessThan(0.004);
    }
  });

  it('분석 쪽 Abel–Noble과 다른 식이다: 450 bar에서 질량 차이 0.3~3%, 같은 밀도에서 온도 의존도 다르다', () => {
    const gap = (bar: number, tempC: number) => abelNobleMassKg(bar, 1, tempC) / h2MassKg(bar, 1, tempC) - 1;

    expect(Math.abs(gap(450, 15))).toBeGreaterThan(0.003);
    expect(Math.abs(gap(450, 15))).toBeLessThan(0.03);
    expect(Math.abs(gap(450, 40) - gap(450, 0))).toBeGreaterThan(0.001);
  });

  it('PLC 재고 추정(온도 무관 2차 비리얼)은 고압에서 참값보다 1% 넘게 크다', () => {
    const truth = h2MassKg(450, 7.4, 20);

    expect(plcH2MassKg(450, 7.4, 20) / truth - 1).toBeGreaterThan(0.01);
    expect(plcH2MassKg(30, 7.4, 20) / h2MassKg(30, 7.4, 20) - 1).toBeLessThan(0.002);
  });
});
