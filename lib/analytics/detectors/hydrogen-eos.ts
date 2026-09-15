// 수소 실기체 상태식 (순수): Abel–Noble ρ = P / (R_s·T + b·P).
// 고압 수소(~700 bar)에서 이상기체보다 NIST 값에 훨씬 가깝고(15 °C 350 bar ≈ 24 kg/m³, 700 bar ≈ 40 kg/m³) 역산이 닫힌 식이다.
// 압력은 절대압 [bar]으로 본다. 상수는 tank.static_leak 파라미터로 바꿀 수 있다.

/** R_s = R/M_H2 [J/(kg·K)] */
export const H2_SPECIFIC_GAS_CONSTANT_DEFAULT = 4124.2;
/** Abel–Noble 공부피 b [m³/kg] */
export const H2_COVOLUME_DEFAULT = 7.69e-3;

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

/** ∂ρ/∂P [kg/m³ per bar] = R_s·T / (R_s·T + b·P)² × 10⁵ — 압력 센서 드리프트를 질량 변화로 환산한다 */
export function h2DensityPerBar(pressureBar: number, tempC: number, constants: AbelNobleConstants = ABEL_NOBLE_DEFAULTS): number {
  const rt = constants.specificGasConstant * kelvin(tempC);
  const denominator = rt + constants.coVolume * Math.max(0, pressureBar) * PA_PER_BAR;
  return (rt / (denominator * denominator)) * PA_PER_BAR;
}
