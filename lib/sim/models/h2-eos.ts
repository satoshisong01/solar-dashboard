// 수소 실기체 상태식 (순수 함수). 두 가지를 둔다.
//
// 1) 시뮬레이터 참값 (저장용기 압력·질량): 비리얼 급수 Z = 1 + B(T)·c + C·c², B(T) = B0 + B1/T, C 상수 (c = 몰 밀도).
//    계수는 NIST 기준식(Lemmon·Huber·Leachman 2008)에 250~345 K · 1~50 MPa 격자로 최소제곱 근사한 값을 반올림했다
//    (그 범위 Z 편차 최대 약 0.35%). 분석 쪽(lib/analytics 체인 원장·tank.static_leak)은 Abel–Noble(b = 7.691e-3 m³/kg)을 쓰므로
//    일부러 다른 식이다: 탐지기가 계산한 재고에 현장처럼 상태식·온도 의존 보정 오차가 남는다.
// 2) 현장 PLC 재고 추정 (h2.inventory 포인트): 온도와 무관한 2차 비리얼(B = 14.5 cm³/mol). 450 bar에서 참값보다 약 2% 과대.
import { GAS_CONSTANT_J_PER_MOL_K, H2_MOLAR_MASS_KG_PER_MOL, KELVIN_OFFSET } from './common';

const PA_PER_BAR = 1e5;
/** B0 [m³/mol] = 17.65 cm³/mol */
const VIRIAL_B0_M3_PER_MOL = 17.65e-6;
/** B1 [m³·K/mol] = −1172 cm³·K/mol */
const VIRIAL_B1_M3_K_PER_MOL = -1_172e-6;
/** C [m⁶/mol²] = 468 cm⁶/mol² */
const VIRIAL_C_M6_PER_MOL2 = 468e-12;
/** PLC 재고 추정용 온도 무관 2차 비리얼 계수 [m³/mol] */
const PLC_VIRIAL_B_M3_PER_MOL = 14.5e-6;
const NEWTON_ITERATIONS = 8;

function kelvin(tempC: number): number {
  const t = tempC + KELVIN_OFFSET;
  if (!(t > 0)) throw new RangeError(`수소 상태식: 절대온도가 0 이하입니다 (${tempC} °C)`);
  return t;
}

/** 참값 상태식의 제2 비리얼 계수 B(T) [m³/mol] */
export const trueSecondVirial = (tempC: number): number => VIRIAL_B0_M3_PER_MOL + VIRIAL_B1_M3_K_PER_MOL / kelvin(tempC);

/** 참값 압축계수 Z(c, T) */
export function trueCompressibility(molarDensity: number, tempC: number): number {
  return 1 + trueSecondVirial(tempC) * molarDensity + VIRIAL_C_M6_PER_MOL2 * molarDensity * molarDensity;
}

/** 참값: 질량·내용적·온도 → 절대압 [bar] (P = Z·c·R·T) */
export function h2PressureBar(massKg: number, volumeM3: number, tempC: number): number {
  const c = Math.max(0, massKg) / H2_MOLAR_MASS_KG_PER_MOL / volumeM3;
  return (trueCompressibility(c, tempC) * c * GAS_CONSTANT_J_PER_MOL_K * kelvin(tempC)) / PA_PER_BAR;
}

/** 참값: 절대압·내용적·온도 → 질량 [kg]. c·R·T·(1 + B·c + C·c²) = P를 뉴턴법으로 푼다 (c > 0에서 단조 증가) */
export function h2MassKg(pressureBar: number, volumeM3: number, tempC: number): number {
  const pressurePa = Math.max(0, pressureBar) * PA_PER_BAR;
  const rt = GAS_CONSTANT_J_PER_MOL_K * kelvin(tempC);
  const b = trueSecondVirial(tempC);
  let c = pressurePa / rt; // 이상기체 초기값
  for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
    const f = rt * c * (1 + b * c + VIRIAL_C_M6_PER_MOL2 * c * c) - pressurePa;
    const df = rt * (1 + 2 * b * c + 3 * VIRIAL_C_M6_PER_MOL2 * c * c);
    c = Math.max(0, c - f / df);
  }
  return c * volumeM3 * H2_MOLAR_MASS_KG_PER_MOL;
}

/** PLC 재고 추정: P(1 − B·c) = c·R·T → c = P/(R·T + P·B) [kg] */
export function plcH2MassKg(pressureBar: number, volumeM3: number, tempC: number): number {
  const pressurePa = Math.max(0, pressureBar) * PA_PER_BAR;
  const c = pressurePa / (GAS_CONSTANT_J_PER_MOL_K * kelvin(tempC) + pressurePa * PLC_VIRIAL_B_M3_PER_MOL);
  return c * volumeM3 * H2_MOLAR_MASS_KG_PER_MOL;
}
