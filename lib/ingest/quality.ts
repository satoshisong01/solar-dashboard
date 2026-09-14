/**
 * om.measurement.quality 비트 (smallint). db/migrations의 measurement 주석과 값이 같아야 한다.
 * 0이면 정상. 여러 비트가 함께 설정될 수 있다.
 */
export const QUALITY = Object.freeze({
  DEVICE_BAD: 1, // 장치가 보낸 품질 코드가 불량
  HARD_RANGE: 2, // metric_def.hard_min/max 밖
  SPIKE: 4,
  FLATLINE: 8, // metric_def.flatline_max_s 넘게 값이 그대로
  CLOCK_SUSPECT: 16, // NTP 미동기 또는 |skew| > 120초
  LATE: 32, // 1시간 이상 늦게 도착
  REPROCESSED: 64, // 미매핑 태그를 매핑한 뒤 원본 배치를 재처리해 넣은 값
} as const);

export type QualityFlag = keyof typeof QUALITY;

/** 값 자체를 믿을 수 없게 하는 비트. 하나라도 켜지면 good이 아니다 (m_1h.n_good에서 빠진다). */
export const BAD_MASK = QUALITY.DEVICE_BAD | QUALITY.HARD_RANGE | QUALITY.SPIKE | QUALITY.FLATLINE;

/**
 * 값은 유효하고 수신·출처 상태만 알리는 비트. good 판정에 영향을 주지 않는다.
 * CLOCK_SUSPECT는 시각이 의심스러울 뿐 값은 유효로 본다 (시각이 중요한 분석은 isGoodWithTrustedClock으로 뺀다).
 */
export const INFO_MASK = QUALITY.CLOCK_SUSPECT | QUALITY.LATE | QUALITY.REPROCESSED;

/** BAD 비트가 하나도 없으면 true. LATE·REPROCESSED·CLOCK_SUSPECT는 무시한다. */
export function isGood(quality: number): boolean {
  return (quality & BAD_MASK) === 0;
}

/** isGood이면서 CLOCK_SUSPECT도 없으면 true (에피소드 경계·지연 시간처럼 시각 정확도가 판정에 들어가는 분석용) */
export function isGoodWithTrustedClock(quality: number): boolean {
  return (quality & (BAD_MASK | QUALITY.CLOCK_SUSPECT)) === 0;
}
