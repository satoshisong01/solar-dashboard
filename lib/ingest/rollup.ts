// dirty 시간 버킷을 원시 측정값에서 다시 집계해 om.m_1h에 반영한다 (설계 §0 롤업, §5.2).
// 크론 없음: 수집 직후 after()와 재처리, (P2) 분석 실행 시작 시 호출한다.
// 'server-only'를 넣지 않는다: tsx 스크립트와 테스트에서도 쓴다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { BAD_MASK, isGood } from './quality';

export const HOUR_MS = 3_600_000;
const DEFAULT_LIMIT = 2_000;
const DEFAULT_MAX_ROUNDS = 50;

export interface RollupStats {
  readonly n: number;
  readonly nGood: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly sum: number | null;
}

export interface RollupSample {
  readonly tsMs: number;
  /** NULL = 값 없음 (수집은 결측을 저장하지 않지만 컬럼은 NULL을 허용한다) */
  readonly value: number | null;
  readonly quality: number;
}

/** UTC 시간 버킷 시작 (epoch ms) */
export function hourBucket(tsMs: number): number {
  return Math.floor(tsMs / HOUR_MS) * HOUR_MS;
}

/**
 * processDirty·rebuildHourlyRollups의 SQL 집계와 같은 규칙의 순수 구현 (검증용).
 * - n: 저장된 샘플 행 수 (값이 NULL인 행 포함)
 * - n_good: 값이 NULL이 아니고 BAD 비트(DEVICE_BAD·HARD_RANGE·SPIKE·FLATLINE)가 없는 행 수.
 *   LATE·REPROCESSED·CLOCK_SUSPECT(INFO 비트)는 good에서 빼지 않는다.
 * - min·max·avg·sum: NULL이 아닌 값만 (품질 비트와 무관하게 모든 저장 값)
 * - first·last: 시각 순으로 처음·마지막인 NULL이 아닌 값
 * - NULL이 아닌 값이 하나도 없으면 값 통계는 모두 null
 * metric_def.rollup(avg/sum/last/max/min/delta)은 조회하는 쪽이 이 통계 중 어느 열을 대표값으로 쓸지 고르는 기준이다.
 */
export function computeHourlyRollup(samples: readonly RollupSample[]): RollupStats {
  const ordered = [...samples].sort((a, b) => a.tsMs - b.tsMs);
  const values = ordered.flatMap((sample) => (sample.value === null ? [] : [sample.value]));
  const nGood = ordered.filter((sample) => sample.value !== null && isGood(sample.quality)).length;
  if (values.length === 0) {
    return { n: ordered.length, nGood, min: null, max: null, avg: null, first: null, last: null, sum: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: ordered.length,
    nGood,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    first: values[0] ?? null,
    last: values[values.length - 1] ?? null,
    sum,
  };
}

/** m_1h 집계 열 (원시 별칭 m). computeHourlyRollup과 같은 규칙. */
const HOURLY_AGGREGATES = sql`
  count(*)::int AS n,
  (count(*) FILTER (WHERE m.value IS NOT NULL AND (m.quality & ${BAD_MASK}::int2) = 0))::int AS n_good,
  min(m.value) AS v_min,
  max(m.value) AS v_max,
  avg(m.value) AS v_avg,
  (array_agg(m.value ORDER BY m.ts ASC) FILTER (WHERE m.value IS NOT NULL))[1] AS v_first,
  (array_agg(m.value ORDER BY m.ts DESC) FILTER (WHERE m.value IS NOT NULL))[1] AS v_last,
  sum(m.value) AS v_sum
`;

/** agg CTE(point_id, bucket, 집계 열)를 m_1h에 upsert하는 문장 */
const UPSERT_FROM_AGG = sql`
  INSERT INTO om.m_1h AS r (point_id, bucket, n, n_good, v_min, v_max, v_avg, v_first, v_last, v_sum, computed_at)
  SELECT point_id, bucket, n, n_good, v_min, v_max, v_avg, v_first, v_last, v_sum, now() FROM agg
  ON CONFLICT (point_id, bucket) DO UPDATE SET
    n = excluded.n, n_good = excluded.n_good, v_min = excluded.v_min, v_max = excluded.v_max,
    v_avg = excluded.v_avg, v_first = excluded.v_first, v_last = excluded.v_last, v_sum = excluded.v_sum,
    computed_at = excluded.computed_at
`;

export interface ProcessDirtyOptions {
  /** 한 번에 처리할 dirty 버킷 수 */
  readonly limit?: number;
  /** 이 포인트들의 버킷만 처리한다 (수집 직후 해당 배치 포인트만) */
  readonly pointIds?: readonly number[];
}

export interface ProcessDirtyResult {
  /** 잠가서 가져온 dirty 버킷 수 */
  readonly picked: number;
  /** m_1h에 쓴 행 수 */
  readonly upserted: number;
  /** gen이 그대로여서 지운 dirty 행 수 (처리 중 새 샘플이 오면 남는다) */
  readonly cleared: number;
}

/**
 * 한 문장(한 스냅샷)에서: dirty를 FOR UPDATE SKIP LOCKED로 가져와 → 원시에서 버킷 재집계 → m_1h upsert
 * → 가져올 때와 gen이 같은 dirty만 삭제. 동시에 들어온 샘플의 dirty 행은 남아 다음 처리 때 다시 계산된다.
 */
export async function processDirty(db: Kysely<DB>, options: ProcessDirtyOptions = {}): Promise<ProcessDirtyResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit은 1 이상의 정수여야 합니다: ${limit}`);
  const pointFilter = options.pointIds === undefined ? sql`true` : sql`point_id = ANY(${[...options.pointIds]}::int4[])`;

  const { rows } = await sql<ProcessDirtyResult>`
    WITH picked AS (
      SELECT point_id, bucket, gen
      FROM om.rollup_dirty
      WHERE ${pointFilter}
      ORDER BY bucket, point_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    agg AS (
      SELECT p.point_id, p.bucket, ${HOURLY_AGGREGATES}
      FROM picked p
      JOIN om.measurement m
        ON m.point_id = p.point_id AND m.ts >= p.bucket AND m.ts < p.bucket + interval '1 hour'
      GROUP BY p.point_id, p.bucket
    ),
    upserted AS (
      ${UPSERT_FROM_AGG}
      RETURNING 1
    ),
    cleared AS (
      DELETE FROM om.rollup_dirty d
      USING picked p
      WHERE d.point_id = p.point_id AND d.bucket = p.bucket AND d.gen = p.gen
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM picked)::int AS picked,
      (SELECT count(*) FROM upserted)::int AS upserted,
      (SELECT count(*) FROM cleared)::int AS cleared
  `.execute(db);

  const [result] = rows;
  if (!result) throw new Error('롤업 결과를 읽지 못했습니다');
  return result;
}

export interface DrainDirtyOptions extends ProcessDirtyOptions {
  /** 무한 반복 방지. 남은 dirty는 다음 수집·분석 실행 때 처리된다 */
  readonly maxRounds?: number;
}

/** 가져올 dirty가 limit보다 적어질 때까지 processDirty를 반복한다. 전체 합계를 돌려준다. */
export async function drainDirty(db: Kysely<DB>, options: DrainDirtyOptions = {}): Promise<ProcessDirtyResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let total: ProcessDirtyResult = { picked: 0, upserted: 0, cleared: 0 };

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await processDirty(db, { limit, pointIds: options.pointIds });
    total = {
      picked: total.picked + result.picked,
      upserted: total.upserted + result.upserted,
      cleared: total.cleared + result.cleared,
    };
    if (result.picked < limit) break;
  }
  return total;
}

export interface RebuildRange {
  /** 포함. UTC 정시여야 한다 (버킷이 두 구간에 나뉘지 않게) */
  readonly fromMs: number;
  /** 제외. UTC 정시 */
  readonly toMs: number;
}

/**
 * [from, to) 원시 전체를 (포인트, UTC 시간)으로 다시 집계해 m_1h에 upsert한다 (집계 규칙이 바뀐 뒤 과거 롤업 재계산용).
 * dirty 대기열은 건드리지 않는다. m_1h에 쓴 행 수를 돌려준다.
 */
export async function rebuildHourlyRollups(db: Kysely<DB>, range: RebuildRange): Promise<number> {
  const { fromMs, toMs } = range;
  if (hourBucket(fromMs) !== fromMs || hourBucket(toMs) !== toMs || toMs <= fromMs) {
    throw new Error(`재계산 구간은 UTC 정시이고 from < to여야 합니다: ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()}`);
  }
  const { rows } = await sql<{ upserted: number }>`
    WITH agg AS (
      SELECT m.point_id, date_trunc('hour', m.ts, 'UTC') AS bucket, ${HOURLY_AGGREGATES}
      FROM om.measurement m
      WHERE m.ts >= ${new Date(fromMs).toISOString()}::timestamptz AND m.ts < ${new Date(toMs).toISOString()}::timestamptz
      GROUP BY 1, 2
    ),
    upserted AS (
      ${UPSERT_FROM_AGG}
      RETURNING 1
    )
    SELECT count(*)::int AS upserted FROM upserted
  `.execute(db);
  return rows[0]?.upserted ?? 0;
}
