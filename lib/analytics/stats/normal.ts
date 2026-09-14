// 표준정규분포 누적분포·분위수 (Theil–Sen 신뢰구간, Mann–Kendall p값용).

/** 오차함수 근사 (Abramowitz & Stegun 7.1.26, 오차 < 1.5e-7) */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Φ(x) */
export const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

const ACKLAM_A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const ACKLAM_B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const ACKLAM_C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

const poly = (coefficients: readonly number[], x: number): number => coefficients.reduce((acc, c) => acc * x + c, 0);

function tail(p: number): number {
  const q = Math.sqrt(-2 * Math.log(p));
  return poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
}

/** Φ⁻¹(p) (Acklam 근사, 상대오차 < 1.2e-9). p는 (0, 1) */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p는 0과 1 사이여야 합니다 (${p})`);
  if (p < P_LOW) return tail(p);
  if (p > 1 - P_LOW) return -tail(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
}
