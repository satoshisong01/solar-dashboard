// finding 신뢰도 점수 (0~1). 표본 수·CI 폭·데이터 완결성·방법 일치를 한 규칙으로 합친다.

export interface ConfidenceInput {
  /** 판정에 쓴 표본 수 (세션·일·에피소드 수) */
  readonly n: number;
  /** 상대 CI 폭 = (CI 상한 − 하한) / |효과 크기|. 0이면 완벽, 2 이상이면 부호도 불확실 */
  readonly ciWidth: number | null;
  /** 입력 데이터 완결성 0~1 */
  readonly dqCompleteness: number;
  /** 독립된 두 번째 방법(추세 검정·CUSUM 등)이 같은 결론인지. 모르면 null */
  readonly methodsAgree: boolean | null;
}

/** n이 이 수 이상이면 표본 점수 1 */
export const CONFIDENCE_FULL_N = 30;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * 규칙:
 *   표본 점수  s_n  = min(1, n / 30)
 *   CI 점수    s_ci = clamp(1 − ciWidth / 2, 0, 1)   (ciWidth null → 0.5)
 *   품질 점수  s_dq = clamp((완결성 − 0.8) / 0.2, 0, 1)  (80% 이하는 0, 100%는 1)
 *   기본 점수 = 0.35·s_n + 0.35·s_ci + 0.30·s_dq
 *   방법 일치 배수 = 일치 1.0 / 불일치 0.6 / 모름 0.85
 *   신뢰도 = 기본 점수 × 배수, 소수 둘째 자리 반올림. n ≤ 0이면 0.
 * 예: 세션 18회, 상대 CI 폭 0.48, 완결성 0.98, 추세 일치 → 0.35·0.6 + 0.35·0.76 + 0.3·0.9 = 0.75
 */
export function scoreConfidence(input: ConfidenceInput): number {
  if (!(input.n > 0)) return 0;
  const sampleScore = Math.min(1, input.n / CONFIDENCE_FULL_N);
  const ciScore = input.ciWidth === null || !Number.isFinite(input.ciWidth) ? 0.5 : clamp01(1 - input.ciWidth / 2);
  const dqScore = clamp01((input.dqCompleteness - 0.8) / 0.2);
  const base = 0.35 * sampleScore + 0.35 * ciScore + 0.3 * dqScore;
  const agreement = input.methodsAgree === null ? 0.85 : input.methodsAgree ? 1 : 0.6;
  return Math.round(clamp01(base * agreement) * 100) / 100;
}

/** 상대 CI 폭. 효과가 0이면 null */
export function relativeCiWidth(effect: number, ciLow: number | null, ciHigh: number | null): number | null {
  if (ciLow === null || ciHigh === null || effect === 0) return null;
  return Math.abs(ciHigh - ciLow) / Math.abs(effect);
}
