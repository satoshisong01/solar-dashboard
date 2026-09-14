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
