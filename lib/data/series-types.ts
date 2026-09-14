// 시계열 조회의 공용 타입·상수·버킷 크기 선택. 순수 모듈 (서버·클라이언트 공용, zod 없음).

const HOUR_S = 3_600;
const DAY_S = 24 * HOUR_S;

export const SERIES_LIMITS = Object.freeze({
  maxPointIds: 8,
  defaultMaxPoints: 600,
  minMaxPoints: 50,
  maxMaxPoints: 2_000,
  /** 이 길이 이하면 원시(measurement), 넘으면 1시간 롤업(m_1h) */
  rawMaxSpanMs: 48 * HOUR_S * 1_000,
  /** 한 번에 조회할 수 있는 최대 기간 */
  maxSpanMs: 366 * DAY_S * 1_000,
});

/** PostgreSQL int4 최댓값 (포인트·설비 id) */
export const INT4_MAX = 2_147_483_647;

/** 버킷 경계 기준: KST 자정. 1시간 이상 버킷도 KST 날짜와 맞는다 */
export const BUCKET_ORIGIN_ISO = '2000-01-01T00:00:00+09:00';

const RAW_STEPS_S = [10, 15, 30, 60, 120, 300, 600, 900, 1_800, HOUR_S] as const;
const HOURLY_STEPS_S = [HOUR_S, 2 * HOUR_S, 3 * HOUR_S, 6 * HOUR_S, 12 * HOUR_S, DAY_S, 2 * DAY_S, 7 * DAY_S] as const;

export type SeriesSource = 'raw' | '1h';

export interface BucketChoice {
  readonly source: SeriesSource;
  readonly bucketSeconds: number;
}

/** 기간 ÷ 최대 점 수 이상인 가장 작은 단계. 1시간 롤업 기반이면 1시간의 배수만 쓴다 */
export function chooseBucket(spanMs: number, maxPoints: number): BucketChoice {
  const source: SeriesSource = spanMs <= SERIES_LIMITS.rawMaxSpanMs ? 'raw' : '1h';
  const targetS = spanMs / 1_000 / maxPoints;
  const steps: readonly number[] = source === 'raw' ? RAW_STEPS_S : HOURLY_STEPS_S;
  const step = steps.find((candidate) => candidate >= targetS);
  return { source, bucketSeconds: step ?? Math.ceil(targetS / DAY_S) * DAY_S };
}

export interface SeriesQuery {
  readonly pointIds: readonly number[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly maxPoints: number;
}

/** [버킷 시작 epoch ms, 최소, 평균, 최대] */
export type SeriesRow = readonly [tsMs: number, min: number | null, avg: number | null, max: number | null];

export interface SeriesPayload {
  readonly source: SeriesSource;
  readonly bucketSeconds: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly series: readonly Readonly<{ pointId: number; rows: readonly SeriesRow[] }>[];
}

/** 클라이언트가 /api/series를 부를 때 쓰는 쿼리 문자열 */
export function buildSeriesSearch(query: SeriesQuery): string {
  const params = new URLSearchParams({
    pointIds: query.pointIds.join(','),
    from: new Date(query.fromMs).toISOString(),
    to: new Date(query.toMs).toISOString(),
    maxPoints: String(query.maxPoints),
  });
  return params.toString();
}
