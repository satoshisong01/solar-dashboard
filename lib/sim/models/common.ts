// 모델 공용 물리 상수와 도우미.

export const FARADAY_C_PER_MOL = 96_485.332_12;
export const GAS_CONSTANT_J_PER_MOL_K = 8.314_462_618;
export const H2_MOLAR_MASS_KG_PER_MOL = 2.015_88e-3;
export const O2_MOLAR_MASS_KG_PER_MOL = 31.998e-3;
/** 건조공기 중 산소 질량분율 */
export const O2_MASS_FRACTION_IN_AIR = 0.2314;
export const KELVIN_OFFSET = 273.15;

/**
 * 셀 1개에 1 A를 1시간 흘릴 때 생성(전해조)·소비(연료전지)되는 수소 질량 [kg/(A·h)].
 * H₂ 1 mol에 전자 2 mol이 필요하므로 ṁ = I × 3600 s / (2F) × M_H2
 *   = 3600 × 2.01588e-3 / (2 × 96485.33212) ≈ 3.7608e-5 kg/(A·h)
 */
export const H2_KG_PER_AMP_HOUR_PER_CELL = (3_600 * H2_MOLAR_MASS_KG_PER_MOL) / (2 * FARADAY_C_PER_MOL);

/** 패러데이 법칙 수소 유량 [kg/h] = N_cell × I × η_F × 3.7608e-5 */
export function faradayH2KgPerH(cellCount: number, currentA: number, faradayEfficiency = 1): number {
  return cellCount * Math.max(0, currentA) * faradayEfficiency * H2_KG_PER_AMP_HOUR_PER_CELL;
}

/** 전력변환기(인버터·PCS·정류기) 부하 의존 손실 계수 */
export interface ConverterLossModel {
  /** 정격 대비 무부하 손실 */
  readonly noLoad: number;
  /** 입력 비례 손실 */
  readonly linear: number;
  /** 입력²/정격 비례 손실 */
  readonly quadratic: number;
}

/** 손실 [kW] = 정격×무부하 + 입력×선형 + 입력²/정격×2차 → 저부하에서 효율이 떨어지는 곡선 */
export function converterLossKw(model: ConverterLossModel, ratedKw: number, inputKw: number): number {
  if (inputKw <= 0) return 0;
  return ratedKw * model.noLoad + inputKw * model.linear + ((inputKw * inputKw) / ratedKw) * model.quadratic;
}

/** 단조 증가 함수 f에서 f(x) = target인 x를 [lo, hi]에서 이분법으로 찾는다. 범위를 넘으면 끝값. */
export function solveIncreasing(f: (x: number) => number, target: number, lo: number, hi: number, iterations = 40): number {
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  let low = lo;
  let high = hi;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (low + high) / 2;
    if (f(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
