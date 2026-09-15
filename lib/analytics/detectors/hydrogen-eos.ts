// 수소 실기체 상태식·패러데이 원단위 (순수). tank.static_leak 탐지기와 체인 원장(lib/analytics/ledger)이 함께 쓰는 유일한 정의다.
// Abel–Noble ρ = P / (R_s·T + b·P): 고압 수소(~700 bar)에서 이상기체보다 NIST 값에 훨씬 가깝고(15 °C 350 bar ≈ 24 kg/m³, 700 bar ≈ 40 kg/m³) 역산이 닫힌 식이다.
// 압력은 절대압 [bar]으로 본다. 상수는 tank.static_leak 파라미터로 바꿀 수 있다.

export const GAS_CONSTANT_J_PER_MOL_K = 8.314_462_618;
export const H2_MOLAR_MASS_KG_PER_MOL = 2.015_88e-3;
export const FARADAY_C_PER_MOL = 96_485.332_12;

/** R_s = R/M_H2 [J/(kg·K)] ≈ 4124.48 */
export const H2_SPECIFIC_GAS_CONSTANT_DEFAULT = GAS_CONSTANT_J_PER_MOL_K / H2_MOLAR_MASS_KG_PER_MOL;
/** Abel–Noble 공부피 b [m³/kg] (Chenoweth 1983, Sandia HyRAM 수소 상태식 기본값) */
export const H2_COVOLUME_DEFAULT = 7.691e-3;
/** 원장 stored_delta 계산 방법 표기 */
export const H2_EOS_VERSION = 'abel_noble@1';

/** 셀 1개·1 A·1 h 이론 수소 [kg/(A·h)] = 3600 × M / (2F) ≈ 3.7608e-5 (lib/sim/models/common.ts와 같은 값) */
export const H2_KG_PER_AMP_HOUR_PER_CELL = (3_600 * H2_MOLAR_MASS_KG_PER_MOL) / (2 * FARADAY_C_PER_MOL);

const KELVIN_OFFSET = 273.15;
const PA_PER_BAR = 1e5;

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

/** 밀도 [kg/m³]. 음수 압력은 0으로 본다 */
export function h2DensityKgM3(pressureBar: number, tempC: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const pressurePa = Math.max(0, pressureBar) * PA_PER_BAR;
  return pressurePa / (constants.specificGasConstant * kelvin(tempC) + constants.coVolume * pressurePa);
}

/** 용기 질량 [kg] = 밀도 × 내용적 */
export const h2MassKg = (pressureBar: number, tempC: number, volumeM3: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number => h2DensityKgM3(pressureBar, tempC, constants) * volumeM3;

/** 역함수: 질량 → 절대압 [bar] = ρ·R_s·T / (1 − b·ρ) */
export function h2PressureBar(massKg: number, tempC: number, volumeM3: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const density = massKg / volumeM3;
  const denominator = 1 - constants.coVolume * density;
  if (!(denominator > 0)) throw new RangeError(`수소 상태식: 밀도 ${density} kg/m³가 공부피 한계를 넘습니다`);
  return (density * constants.specificGasConstant * kelvin(tempC)) / denominator / PA_PER_BAR;
}

/** ∂ρ/∂P [kg/m³ per bar] = R_s·T / (R_s·T + b·P)² × 10⁵ — 압력 센서 드리프트를 질량 변화로 환산한다 */
export function h2DensityPerBar(pressureBar: number, tempC: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const rt = constants.specificGasConstant * kelvin(tempC);
  const denominator = rt + constants.coVolume * Math.max(0, pressureBar) * PA_PER_BAR;
  return (rt / (denominator * denominator)) * PA_PER_BAR;
}
