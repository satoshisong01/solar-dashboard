// 적재 검증(verify:ingest)용 DB 관측. 판정은 lib/sim/verify-checks의 순수 함수가 한다.
// 'server-only'를 넣지 않는다: tsx 스크립트와 integration 테스트에서 쓴다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { RollupObservation, SiteObservation } from '@/lib/sim/verify-checks';
import { BAD_MASK, QUALITY } from './quality';
import { drainDirty } from './rollup';

/** avg·sum 비교 허용 오차: |a − b| ≤ 1e-9 × max(|a|, |b|, 1) */
export const FLOAT_TOLERANCE = 1e-9;
const DRAIN_LIMIT = 5_000;
const DRAIN_PASSES = 30;
const DRAIN_WAIT_MS = 1_000;

export interface SampleWindow {
  readonly minTsMs: number;
  readonly maxTsMs: number;
}

const toIso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 남은 dirty 버킷을 모두 롤업한다. 서버의 after() 롤업이 아직 잡고 있는 행(SKIP LOCKED)은 잠시 기다렸다 다시 본다.
 * 끝난 뒤 남은 dirty 행 수를 돌려준다.
 */
export async function drainAllDirty(db: Kysely<DB>): Promise<{ readonly processed: number; readonly remaining: number }> {
  let processed = 0;
  for (let pass = 0; pass < DRAIN_PASSES; pass += 1) {
    const result = await drainDirty(db, { limit: DRAIN_LIMIT, maxRounds: 1_000_000 });
    processed += result.picked;
    const { rows } = await sql<{ remaining: number }>`SELECT count(*)::int AS remaining FROM om.rollup_dirty`.execute(db);
    const remaining = rows[0]?.remaining ?? 0;
    if (remaining === 0) return { processed, remaining };
    if (pass < DRAIN_PASSES - 1) await sleep(DRAIN_WAIT_MS);
  }
  const { rows } = await sql<{ remaining: number }>`SELECT count(*)::int AS remaining FROM om.rollup_dirty`.execute(db);
  return { processed, remaining: rows[0]?.remaining ?? 0 };
}

/** 사이트별 샘플 행 수·품질 비트·안전 이벤트(샘플 시각 범위 안)와 미매핑 인박스 */
export async function observeSites(db: Kysely<DB>, siteCodes: readonly string[], window: SampleWindow): Promise<Readonly<Record<string, SiteObservation>>> {
  const codes = [...siteCodes];
  const from = toIso(window.minTsMs);
  const to = toIso(window.maxTsMs);
  const [samples, events, unmapped] = await Promise.all([
    sql<{ site: string; samples: number; clock_suspect: number; late: number }>`
      SELECT s.code AS site,
        count(*)::int AS samples,
        (count(*) FILTER (WHERE m.quality & ${QUALITY.CLOCK_SUSPECT} <> 0))::int AS clock_suspect,
        (count(*) FILTER (WHERE m.quality & ${QUALITY.LATE} <> 0))::int AS late
      FROM om.measurement m
      JOIN om.point p ON p.id = m.point_id
      JOIN om.gateway g ON g.id = p.gateway_id
      JOIN om.site s ON s.id = g.site_id
      WHERE s.code = ANY(${codes}::text[]) AND m.ts BETWEEN ${from}::timestamptz AND ${to}::timestamptz
      GROUP BY s.code
    `.execute(db),
    sql<{ site: string; safety: number }>`
      SELECT s.code AS site, (count(*) FILTER (WHERE e.is_safety))::int AS safety
      FROM om.event_log e JOIN om.site s ON s.id = e.site_id
      WHERE s.code = ANY(${codes}::text[]) AND e.ts BETWEEN ${from}::timestamptz AND ${to}::timestamptz
      GROUP BY s.code
    `.execute(db),
    sql<{ site: string; source_key: string; sample_count: number }>`
      SELECT s.code AS site, u.source_key, u.sample_count::int8::float8 AS sample_count
      FROM om.unmapped_source u
      JOIN om.gateway g ON g.id = u.gateway_id
      JOIN om.site s ON s.id = g.site_id
      WHERE s.code = ANY(${codes}::text[])
      ORDER BY s.code, u.source_key
    `.execute(db),
  ]);

  return Object.fromEntries(
    codes.map((code) => {
      const row = samples.rows.find((r) => r.site === code);
      return [
        code,
        {
          samples: row?.samples ?? 0,
          clockSuspect: row?.clock_suspect ?? 0,
          late: row?.late ?? 0,
          safetyEvents: events.rows.find((r) => r.site === code)?.safety ?? 0,
          unmapped: unmapped.rows.filter((r) => r.site === code).map((r) => ({ sourceKey: r.source_key, sampleCount: r.sample_count })),
        },
      ];
    }),
  );
}

/**
 * 원시 측정값 전체를 (포인트, UTC 시간)으로 다시 집계해 om.m_1h 전체와 FULL JOIN으로 비교한다 (표본 추출 없음).
 * 정수·min·max·first·last는 완전 일치, avg·sum은 비트 차이와 허용 오차 초과를 따로 센다
 * (같은 값이라도 합산 순서가 다르면 마지막 비트가 달라질 수 있다).
 */
export async function observeRollup(db: Kysely<DB>): Promise<Omit<RollupObservation, 'dirtyRemaining'>> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL work_mem = '256MB'`.execute(trx);
    const { rows } = await sql<Omit<RollupObservation, 'dirtyRemaining'>>`
      WITH raw AS (
        SELECT point_id, bucket, n, n_good, v_min, v_max, v_avg, v_sum, vals[1] AS v_first, vals[cardinality(vals)] AS v_last
        FROM (
          SELECT point_id, date_trunc('hour', ts, 'UTC') AS bucket,
            count(*)::int AS n, (count(*) FILTER (WHERE value IS NOT NULL AND (quality & ${BAD_MASK}::int2) = 0))::int AS n_good,
            min(value) AS v_min, max(value) AS v_max, avg(value) AS v_avg, sum(value) AS v_sum,
            array_agg(value ORDER BY ts) FILTER (WHERE value IS NOT NULL) AS vals
          FROM om.measurement
          GROUP BY 1, 2
        ) grouped
      ),
      joined AS (
        SELECT raw.point_id IS NOT NULL AS has_raw, r.point_id IS NOT NULL AS has_rollup,
          (raw.n, raw.n_good, raw.v_min, raw.v_max, raw.v_first, raw.v_last) IS DISTINCT FROM (r.n, r.n_good, r.v_min, r.v_max, r.v_first, r.v_last) AS exact_diff,
          (raw.v_avg, raw.v_sum) IS DISTINCT FROM (r.v_avg, r.v_sum) AS bit_diff,
          GREATEST(
            abs(COALESCE(raw.v_avg, 0) - COALESCE(r.v_avg, 0)) / GREATEST(abs(COALESCE(raw.v_avg, 0)), abs(COALESCE(r.v_avg, 0)), 1),
            abs(COALESCE(raw.v_sum, 0) - COALESCE(r.v_sum, 0)) / GREATEST(abs(COALESCE(raw.v_sum, 0)), abs(COALESCE(r.v_sum, 0)), 1)
          ) AS scaled_diff
        FROM raw FULL JOIN om.m_1h r USING (point_id, bucket)
      )
      SELECT
        count(*)::int AS "buckets",
        (count(*) FILTER (WHERE NOT has_rollup))::int AS "missingRollups",
        (count(*) FILTER (WHERE NOT has_raw))::int AS "orphanRollups",
        (count(*) FILTER (WHERE has_raw AND has_rollup AND exact_diff))::int AS "exactMismatches",
        (count(*) FILTER (WHERE has_raw AND has_rollup AND bit_diff))::int AS "floatBitDiffs",
        (count(*) FILTER (WHERE has_raw AND has_rollup AND scaled_diff > ${FLOAT_TOLERANCE}))::int AS "floatMismatches",
        COALESCE(max(scaled_diff) FILTER (WHERE has_raw AND has_rollup), 0)::float8 AS "maxScaledDiff"
      FROM joined
    `.execute(trx);
    const [row] = rows;
    if (!row) throw new Error('롤업 비교 결과를 읽지 못했습니다');
    return row;
  });
}
