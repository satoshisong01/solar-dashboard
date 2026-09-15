// 탐지기 설정 버전 저장·활성 전환 (om.detector_config). (탐지기, 범위)마다 활성은 하나(부분 유니크 인덱스)라
// 새 버전 INSERT와 이전 활성 끄기를 한 트랜잭션에서 하고, 같은 (탐지기, 범위) 동시 저장은 advisory xact lock으로 줄 세운다.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인·폼 검증은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { ConfigVersionRow } from '@/lib/detector-config/history';
import type { ParamValue } from '@/lib/detector-config/types';

export interface NewConfigVersion {
  readonly detectorId: string;
  readonly scope: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  /** [startMs, endMs) */
  readonly referenceWindow: Readonly<{ startMs: number; endMs: number }> | null;
  readonly actor: string;
}

const lockKey = (detectorId: string, scope: string): string => `${detectorId}|${scope}`;

/** 새 버전(= 기존 최대 + 1)을 활성으로 넣고 같은 (탐지기, 범위)의 이전 활성 버전을 끈다. 새 버전 번호를 돌려준다 */
export async function createDetectorConfigVersion(db: Kysely<DB>, input: NewConfigVersion): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('om.detector_config'), hashtext(${lockKey(input.detectorId, input.scope)}))`.execute(trx);
    const current = await trx
      .selectFrom('om.detector_config')
      .select(sql<number>`coalesce(max(version), 0)::int`.as('max'))
      .where('detector_id', '=', input.detectorId)
      .where('scope', '=', input.scope)
      .executeTakeFirstOrThrow();
    const version = current.max + 1;
    await trx.updateTable('om.detector_config').set({ active: false }).where('detector_id', '=', input.detectorId).where('scope', '=', input.scope).where('active', '=', true).execute();
    const window = input.referenceWindow;
    await trx
      .insertInto('om.detector_config')
      .values({
        detector_id: input.detectorId,
        scope: input.scope,
        version,
        params: JSON.stringify(input.params),
        reference_window: window === null ? null : sql<string>`tstzrange(${new Date(window.startMs).toISOString()}::timestamptz, ${new Date(window.endMs).toISOString()}::timestamptz, '[)')`,
        active: true,
        created_by: input.actor,
      })
      .execute();
    return version;
  });
}

export type SetActiveResult = 'saved' | 'not_found';

/** 버전 하나를 켜거나 끈다. 켜면 같은 (탐지기, 범위)의 다른 활성 버전을 먼저 끈다 */
export async function setDetectorConfigActive(db: Kysely<DB>, input: Readonly<{ detectorId: string; scope: string; version: number; active: boolean }>): Promise<SetActiveResult> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('om.detector_config'), hashtext(${lockKey(input.detectorId, input.scope)}))`.execute(trx);
    const target = await trx
      .selectFrom('om.detector_config')
      .select('version')
      .where('detector_id', '=', input.detectorId)
      .where('scope', '=', input.scope)
      .where('version', '=', input.version)
      .executeTakeFirst();
    if (!target) return 'not_found';
    if (input.active) {
      await trx.updateTable('om.detector_config').set({ active: false }).where('detector_id', '=', input.detectorId).where('scope', '=', input.scope).where('active', '=', true).where('version', '<>', input.version).execute();
    }
    await trx.updateTable('om.detector_config').set({ active: input.active }).where('detector_id', '=', input.detectorId).where('scope', '=', input.scope).where('version', '=', input.version).execute();
    return 'saved';
  });
}

/** 설비가 있고 설비 종류가 맞는지 (asset:<id> 범위 저장 전 확인) */
export async function assetHasClass(db: Kysely<DB>, assetId: number, classKey: string): Promise<boolean> {
  const row = await db.selectFrom('om.asset').select('id').where('id', '=', assetId).where('class_key', '=', classKey).executeTakeFirst();
  return row !== undefined;
}

interface ConfigDbRow {
  readonly detector_id: string;
  readonly scope: string;
  readonly version: number;
  readonly params: unknown;
  readonly ref_start_day: string | null;
  readonly ref_end_day: string | null;
  readonly active: boolean;
  readonly created_by: string;
  readonly created_ms: number;
}

const paramsOf = (value: unknown): Readonly<Record<string, unknown>> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** 탐지기 하나의 모든 설정 버전. 기준 창은 KST 날짜(끝은 upper − 1일, 포함) */
export async function loadDetectorConfigVersions(db: Kysely<DB>, detectorId: string): Promise<readonly ConfigVersionRow[]> {
  const { rows } = await sql<ConfigDbRow>`
    SELECT detector_id, scope, version, params, active, created_by,
      (extract(epoch FROM created_at) * 1000)::float8 AS created_ms,
      to_char(lower(reference_window) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS ref_start_day,
      to_char((upper(reference_window) AT TIME ZONE 'Asia/Seoul') - interval '1 day', 'YYYY-MM-DD') AS ref_end_day
    FROM om.detector_config
    WHERE detector_id = ${detectorId}
    ORDER BY scope, version
  `.execute(db);
  return rows.map((r) => ({
    scope: r.scope,
    version: r.version,
    params: paramsOf(r.params),
    referenceWindow: r.ref_start_day !== null && r.ref_end_day !== null ? { startDay: r.ref_start_day, endDay: r.ref_end_day } : null,
    active: r.active,
    createdBy: r.created_by,
    createdAtMs: r.created_ms,
  }));
}
