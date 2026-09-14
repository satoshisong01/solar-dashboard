// 미매핑 인박스 태그 → 포인트 생성, 매핑한 태그의 원본 배치 재처리 (설계 §3 기둥 1, §5.1 규칙 5).
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { MappingInput } from '@/lib/forms/mapping';
import { replayGateway, type ReplayResult } from '@/lib/ingest/replay';
import { PG_UNIQUE_VIOLATION, pgConstraint, pgErrorCode } from './pg-errors';

export type CreatePointResult =
  | Readonly<{ kind: 'created'; pointId: number; assetId: number; siteCode: string }>
  | Readonly<{ kind: 'inbox_missing' | 'already_mapped' | 'asset_not_in_site' | 'metric_missing' | 'duplicate_point' }>;

/** 인박스 행과 게이트웨이 사이트 */
async function findInboxRow(db: Kysely<DB>, gatewayId: number, sourceKey: string) {
  return db
    .selectFrom('om.unmapped_source as u')
    .innerJoin('om.gateway as g', 'g.id', 'u.gateway_id')
    .innerJoin('om.site as s', 's.id', 'g.site_id')
    .select(['u.unit', 'g.site_id', 's.code as site_code'])
    .where('u.gateway_id', '=', gatewayId)
    .where('u.source_key', '=', sourceKey)
    .executeTakeFirst();
}

/**
 * 인박스에 있는 태그를 게이트웨이 사이트의 설비·메트릭에 매핑한다. 원본 단위는 인박스에 기록된 값을 쓴다.
 * 이미 매핑된 태그, 다른 사이트 설비, 같은 (설비, 메트릭, 구분자) 포인트는 만들지 않는다.
 */
export async function createPointFromInbox(db: Kysely<DB>, input: MappingInput): Promise<CreatePointResult> {
  const inbox = await findInboxRow(db, input.gatewayId, input.sourceKey);
  if (!inbox) return { kind: 'inbox_missing' };

  const [mapped, asset, metric] = await Promise.all([
    db.selectFrom('om.point').select('id').where('gateway_id', '=', input.gatewayId).where('source_key', '=', input.sourceKey).executeTakeFirst(),
    db.selectFrom('om.asset').select('id').where('id', '=', input.assetId).where('site_id', '=', inbox.site_id).executeTakeFirst(),
    db.selectFrom('om.metric_def').select('key').where('key', '=', input.metricKey).executeTakeFirst(),
  ]);
  if (mapped) return { kind: 'already_mapped' };
  if (!asset) return { kind: 'asset_not_in_site' };
  if (!metric) return { kind: 'metric_missing' };

  try {
    const point = await db
      .insertInto('om.point')
      .values({
        asset_id: input.assetId,
        metric_key: input.metricKey,
        qualifier: input.qualifier,
        gateway_id: input.gatewayId,
        source_key: input.sourceKey,
        source_unit: inbox.unit,
        scale: input.scale,
        value_offset: input.valueOffset,
        period_s: input.periodS,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { kind: 'created', pointId: point.id, assetId: input.assetId, siteCode: inbox.site_code };
  } catch (error) {
    if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
    // 동시에 같은 태그를 매핑하면 (gateway_id, source_key) 제약이, 같은 설비·메트릭이면 다른 제약이 걸린다.
    return { kind: pgConstraint(error)?.includes('source_key') ? 'already_mapped' : 'duplicate_point' };
  }
}

export interface PendingReplayTag {
  readonly sourceKey: string;
  readonly firstSeenAt: Date;
}

/** 포인트가 생겼지만 아직 인박스에 남아 있는 태그 = 재처리 대기 */
export async function listPendingReplayTags(db: Kysely<DB>, gatewayId: number): Promise<readonly PendingReplayTag[]> {
  const rows = await db
    .selectFrom('om.unmapped_source as u')
    .innerJoin('om.point as p', (join) => join.onRef('p.gateway_id', '=', 'u.gateway_id').onRef('p.source_key', '=', 'u.source_key'))
    .select(['u.source_key', 'u.first_seen_at'])
    .where('u.gateway_id', '=', gatewayId)
    .orderBy('u.source_key')
    .execute();
  return rows.map((row) => ({ sourceKey: row.source_key, firstSeenAt: row.first_seen_at }));
}

export type ReplayMappedResult =
  | Readonly<{ kind: 'nothing' }>
  | Readonly<{ kind: 'done'; sourceKeys: readonly string[]; replay: ReplayResult; clearedInbox: number }>;

/**
 * 재처리 대기 태그만 골라, 그 태그가 처음 들어온 배치부터 원본을 다시 정규화해 채운 뒤 롤업한다.
 * 끝나면 해당 인박스 행을 지운다 (포인트가 생겼으므로 이후 수신분은 인박스에 쌓이지 않는다). 원본 배치는 그대로 둔다.
 */
export async function replayMappedTags(db: Kysely<DB>, gatewayId: number): Promise<ReplayMappedResult> {
  const pending = await listPendingReplayTags(db, gatewayId);
  if (pending.length === 0) return { kind: 'nothing' };

  const sourceKeys = pending.map((tag) => tag.sourceKey);
  const from = new Date(Math.min(...pending.map((tag) => tag.firstSeenAt.getTime())));
  const replay = await replayGateway(db, gatewayId, { from, sourceKeys });

  const cleared = await db
    .deleteFrom('om.unmapped_source as u')
    .where('u.gateway_id', '=', gatewayId)
    .where('u.source_key', 'in', [...sourceKeys])
    .where(({ exists, selectFrom }) =>
      exists(selectFrom('om.point as p').select(sql`1`.as('one')).whereRef('p.gateway_id', '=', 'u.gateway_id').whereRef('p.source_key', '=', 'u.source_key')),
    )
    .executeTakeFirst();
  return { kind: 'done', sourceKeys, replay, clearedInbox: Number(cleared.numDeletedRows) };
}
