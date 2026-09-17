// 같은 사이트 분석의 동시 실행 방지 (마이그레이션 om.analysis_run 주석의 방침).
// 전용 연결 하나에서 트랜잭션을 열고 사이트 id 오름차순으로 pg_try_advisory_xact_lock(hashtext('om.analysis_run'), site_id)를 잡는다.
// 작업은 다른 풀 연결에서 하고, 끝나면(또는 프로세스가 죽어 연결이 끊기면) 트랜잭션이 끝나며 잠금이 풀린다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';

export const ANALYSIS_LOCK_NAMESPACE = 'om.analysis_run';

export type LockOutcome<T> = { readonly acquired: false; readonly busySiteId: number } | { readonly acquired: true; readonly value: T };

export async function withSiteLocks<T>(db: Kysely<DB>, siteIds: readonly number[], work: () => Promise<T>): Promise<LockOutcome<T>> {
  const ordered = [...new Set(siteIds)].sort((a, b) => a - b);
  return db.connection().execute(async (connection) => {
    await sql`BEGIN`.execute(connection);
    try {
      for (const siteId of ordered) {
        const { rows } = await sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(hashtext(${ANALYSIS_LOCK_NAMESPACE}), ${siteId}::int4) AS locked`.execute(connection);
        if (rows[0]?.locked !== true) return { acquired: false, busySiteId: siteId };
      }
      return { acquired: true, value: await work() };
    } finally {
      await sql`ROLLBACK`.execute(connection); // 이 트랜잭션은 잠금만 들고 있으므로 되돌려 잠금을 푼다
    }
  });
}

/**
 * 잠금을 잡은 뒤: 같은 사이트를 포함한 채 running으로 남은 실행 중 startedBefore(= 지금 − 시간 예산 × 2)보다 먼저 시작한 행만 중단된 실행으로 정리한다.
 * 방금 들어와 잠금을 기다리는(곧 AnalysisBusyError로 끝날) 다른 요청의 행을 중단 실행으로 잘못 덮지 않기 위해서다.
 * 정상 실행은 시간 예산 안에서 끝나므로 예산의 두 배가 지나도 running이면 프로세스가 죽은 것으로 본다.
 */
export async function failAbandonedRuns(db: Kysely<DB>, runId: string, siteIds: readonly number[], startedBefore: Date): Promise<number> {
  const result = await sql`
    UPDATE om.analysis_run r
    SET status = 'failed', finished_at = greatest(now(), r.started_at), error = '중단된 실행: 잠금 없이 running 상태로 남아 있었습니다'
    WHERE r.status = 'running' AND r.id <> ${runId}::int8 AND r.started_at < ${startedBefore.toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.scope -> 'siteIds') AS e(site_id) WHERE e.site_id::int = ANY(${[...siteIds]}::int4[]))
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

export interface BusyRun {
  readonly runId: string;
  /** 요청한 사이트 중 이 실행이 이미 잡고 있는 사이트 */
  readonly siteIds: readonly number[];
  readonly startedMs: number;
}

/**
 * 화면이 실행을 시작하기 전에 쓰는 사전 검사: 아직 살아 있는 running 실행 중 요청한 사이트와 겹치는 첫 행.
 * startedAfter(= 지금 − 시간 예산 × 2)보다 먼저 시작한 행은 중단된 실행으로 보고 막지 않는다 (failAbandonedRuns가 정리한다).
 * 실제 직렬화는 withSiteLocks의 advisory 잠금이 하고, 이 검사는 사용자에게 곧바로 이유를 알려 주기 위한 것이다.
 */
export async function findBusyRun(db: Kysely<DB>, siteIds: readonly number[], startedAfter: Date): Promise<BusyRun | null> {
  const { rows } = await sql<{ id: string; started_at: Date; site_ids: number[] }>`
    SELECT r.id, r.started_at,
      (SELECT array_agg(DISTINCT e.site_id::int) FROM jsonb_array_elements_text(r.scope -> 'siteIds') AS e(site_id) WHERE e.site_id::int = ANY(${[...siteIds]}::int4[])) AS site_ids
    FROM om.analysis_run r
    WHERE r.status = 'running' AND r.started_at >= ${startedAfter.toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.scope -> 'siteIds') AS e(site_id) WHERE e.site_id::int = ANY(${[...siteIds]}::int4[]))
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1
  `.execute(db);
  const row = rows[0];
  return row ? { runId: String(row.id), siteIds: [...(row.site_ids ?? [])], startedMs: row.started_at.getTime() } : null;
}
