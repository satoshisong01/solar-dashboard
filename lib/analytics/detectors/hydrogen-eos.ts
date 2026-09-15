// 수소 실기체 상태식·패러데이 원단위 (순수). tank.static_leak 탐지기와 체인 원장(lib/analytics/ledger)이 함께 쓰는 유일한 정의다.
//   기본 lemmon2008: NIST 수소 연료 계량용 표준 밀도식 Z(T, P) = 1 + Σ aᵢ(100/T)^bᵢ(P/MPa)^cᵢ (Lemmon·Huber·Leachman 2008, 220~1000 K·70 MPa, 불확도 약 0.01%)
//   abel_noble: ρ = P / (R_s·T + b·P). 닫힌 식이라 간단하지만 고압에서 NIST 대비 약 ±0.5%, 온도 의존도가 달라 야간 냉각 구간에 겉보기 질량 변화(용기당 수 g/K)를 남긴다
// 압력은 절대압 [bar]으로 본다.

export const GAS_CONSTANT_J_PER_MOL_K = 8.314_462_618;
export const H2_MOLAR_MASS_KG_PER_MOL = 2.015_88e-3;
export const FARADAY_C_PER_MOL = 96_485.332_12;

/** R_s = R/M_H2 [J/(kg·K)] ≈ 4124.48 */
export const H2_SPECIFIC_GAS_CONSTANT_DEFAULT = GAS_CONSTANT_J_PER_MOL_K / H2_MOLAR_MASS_KG_PER_MOL;
/** Abel–Noble 공부피 b [m³/kg] (Chenoweth 1983, Sandia HyRAM 수소 상태식 기본값) */
export const H2_COVOLUME_DEFAULT = 7.691e-3;

export const H2_EOS_MODELS = ['lemmon2008', 'abel_noble'] as const;
export type H2EosModel = (typeof H2_EOS_MODELS)[number];
/** 원장 stored_delta 계산 방법 표기 (기본 모델) */
export const H2_EOS_VERSION = 'lemmon2008@1';

/** 셀 1개·1 A·1 h 이론 수소 [kg/(A·h)] = 3600 × M / (2F) ≈ 3.7608e-5 (lib/sim/models/common.ts와 같은 값) */
export const H2_KG_PER_AMP_HOUR_PER_CELL = (3_600 * H2_MOLAR_MASS_KG_PER_MOL) / (2 * FARADAY_C_PER_MOL);

const KELVIN_OFFSET = 273.15;
const PA_PER_BAR = 1e5;
const BAR_PER_MPA = 10;
const PRESSURE_ITERATIONS = 30;
const DERIVATIVE_STEP_BAR = 0.05;

export interface AbelNobleConstants {
  /** R_s [J/(kg·K)] */
  readonly specificGasConstant: number;
  /** b [m³/kg] */
  readonly coVolume: number;
}

export const ABEL_NOBLE_DEFAULTS: AbelNobleConstants = Object.freeze({ specificGasConstant: H2_SPECIFIC_GAS_CONSTANT_DEFAULT, coVolume: H2_COVOLUME_DEFAULT });

function kelvin(tempC: number): number {
  const t = tempC + KELVIN_OFFSET;
  if (!(t > 0)) throw new RangeError(`수소 상태식: 절대온도가 0 이하입니다 (${tempC} °C)`);
  return t;
}

// ── Abel–Noble ─────────────────────────────────────────────────────────

/** Abel–Noble 밀도 [kg/m³]. 음수 압력은 0으로 본다 */
export function h2DensityKgM3(pressureBar: number, tempC: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const pressurePa = Math.max(0, pressureBar) * PA_PER_BAR;
  return pressurePa / (constants.specificGasConstant * kelvin(tempC) + constants.coVolume * pressurePa);
}

/** Abel–Noble 용기 질량 [kg] = 밀도 × 내용적 */
export const h2MassKg = (pressureBar: number, tempC: number, volumeM3: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number => h2DensityKgM3(pressureBar, tempC, constants) * volumeM3;

/** Abel–Noble 역함수: 질량 → 절대압 [bar] = ρ·R_s·T / (1 − b·ρ) */
export function h2PressureBar(massKg: number, tempC: number, volumeM3: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const density = massKg / volumeM3;
  const denominator = 1 - constants.coVolume * density;
  if (!(denominator > 0)) throw new RangeError(`수소 상태식: 밀도 ${density} kg/m³가 공부피 한계를 넘습니다`);
  return (density * constants.specificGasConstant * kelvin(tempC)) / denominator / PA_PER_BAR;
}

/** Abel–Noble ∂ρ/∂P [kg/m³ per bar] = R_s·T / (R_s·T + b·P)² × 10⁵ */
export function h2DensityPerBar(pressureBar: number, tempC: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const rt = constants.specificGasConstant * kelvin(tempC);
  const denominator = rt + constants.coVolume * Math.max(0, pressureBar) * PA_PER_BAR;
  return (rt / (denominator * denominator)) * PA_PER_BAR;
}

// ── NIST Lemmon·Huber·Leachman 2008 ───────────────────────────────────

const LEMMON_A = [0.0588846, -0.06136111, -0.002650473, 0.002731125, 0.001802374, -0.001150707, 0.9588528e-4, -0.110904e-6, 0.1264403e-9] as const;
const LEMMON_B = [1.325, 1.87, 2.5, 2.8, 2.938, 3.14, 3.37, 3.75, 4.0] as const;
const LEMMON_C = [1.0, 1.0, 2.0, 2.0, 2.42, 2.63, 3.0, 4.0, 5.0] as const;

/** 압축계수 Z(T, P) (검증점: 300 K·10 MPa → 1.05985282) */
export function lemmonCompressibility(pressureBar: number, tempC: number): number {
  const inverseT = 100 / kelvin(tempC);
  const pMpa = Math.max(0, pressureBar) / BAR_PER_MPA;
  return 1 + LEMMON_A.reduce((sum, a, i) => sum + a * inverseT ** (LEMMON_B[i] as number) * pMpa ** (LEMMON_C[i] as number), 0);
}

export function h2DensityLemmonKgM3(pressureBar: number, tempC: number): number {
  const pressurePa = Math.max(0, pressureBar) * PA_PER_BAR;
  return pressurePa / (lemmonCompressibility(pressureBar, tempC) * H2_SPECIFIC_GAS_CONSTANT_DEFAULT * kelvin(tempC));
}

/** 역함수: 질량 → 절대압 [bar]. P = ρ·Z(T, P)·R_s·T 고정점 반복 (Z가 P에 완만해 수렴이 빠르다) */
export function h2PressureLemmonBar(massKg: number, tempC: number, volumeM3: number): number {
  const rhoRt = (Math.max(0, massKg) / volumeM3) * H2_SPECIFIC_GAS_CONSTANT_DEFAULT * kelvin(tempC);
  let pressureBar = rhoRt / PA_PER_BAR;
  for (let i = 0; i < PRESSURE_ITERATIONS; i += 1) pressureBar = (rhoRt * lemmonCompressibility(pressureBar, tempC)) / PA_PER_BAR;
  return pressureBar;
}

/** 모델 하나의 밀도·질량·역함수·∂ρ/∂P */
export interface H2Eos {
  readonly model: H2EosModel;
  readonly density: (pressureBar: number, tempC: number) => number;
  readonly mass: (pressureBar: number, tempC: number, volumeM3: number) => number;
  readonly pressure: (massKg: number, tempC: number, volumeM3: number) => number;
  readonly densityPerBar: (pressureBar: number, tempC: number) => number;
}

export const LEMMON_EOS: H2Eos = Object.freeze({
  model: 'lemmon2008',
  density: h2DensityLemmonKgM3,
  mass: (pressureBar: number, tempC: number, volumeM3: number) => h2DensityLemmonKgM3(pressureBar, tempC) * volumeM3,
  pressure: h2PressureLemmonBar,
  densityPerBar: (pressureBar: number, tempC: number) => (h2DensityLemmonKgM3(pressureBar + DERIVATIVE_STEP_BAR, tempC) - h2DensityLemmonKgM3(Math.max(0, pressureBar - DERIVATIVE_STEP_BAR), tempC)) / (pressureBar + DERIVATIVE_STEP_BAR - Math.max(0, pressureBar - DERIVATIVE_STEP_BAR)),
});

export function h2Eos(model: H2EosModel, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): H2Eos {
  if (model === 'lemmon2008') return LEMMON_EOS;
  return {
    model,
    density: (pressureBar, tempC) => h2DensityKgM3(pressureBar, tempC, constants),
    mass: (pressureBar, tempC, volumeM3) => h2MassKg(pressureBar, tempC, volumeM3, constants),
    pressure: (massKg, tempC, volumeM3) => h2PressureBar(massKg, tempC, volumeM3, constants),
    densityPerBar: (pressureBar, tempC) => h2DensityPerBar(pressureBar, tempC, constants),
  };
}
