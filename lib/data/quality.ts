// 품질 비트 표시·판정. 순수 모듈 (서버·클라이언트 공용).
import { QUALITY, type QualityFlag } from '@/lib/ingest/quality';

/**
 * 값의 유효성을 의심하게 하는 비트. LATE(늦게 도착)·REPROCESSED(재처리로 채움)는 값이 틀렸다는 뜻이 아니라
 * 출처 표시이므로 품질 이상 비율에서 뺀다 (과거분 적재 시 거의 모든 샘플에 LATE가 붙는다).
 */
export const INVALID_QUALITY_MASK =
  QUALITY.DEVICE_BAD | QUALITY.HARD_RANGE | QUALITY.SPIKE | QUALITY.FLATLINE | QUALITY.CLOCK_SUSPECT;

export const QUALITY_LABELS: Readonly<Record<QualityFlag, string>> = {
  DEVICE_BAD: '장치 불량',
  HARD_RANGE: '범위 밖',
  SPIKE: '급변',
  FLATLINE: '고착',
  CLOCK_SUSPECT: '시계 의심',
  LATE: '지연 도착',
  REPROCESSED: '재처리',
};

const FLAGS = Object.keys(QUALITY) as QualityFlag[];

/** quality 값에 켜진 비트 이름 (QUALITY 정의 순서) */
export function qualityFlags(quality: number): readonly QualityFlag[] {
  return FLAGS.filter((flag) => (quality & QUALITY[flag]) !== 0);
}

export function isInvalidFlag(flag: QualityFlag): boolean {
  return (QUALITY[flag] & INVALID_QUALITY_MASK) !== 0;
}
