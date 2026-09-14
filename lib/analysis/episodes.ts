// om.episode 저장·조회. 다시 추출한 구간은 지우고 새로 넣어(겹침 재처리) 시작 시각이 바뀐 에피소드가 남지 않게 한다.
import { sql, type Kysely } from 'kysely';
import { extractorId, type EpisodeKind } from '@/lib/analytics/episodes/types';
import { EPISODE_KINDS, type ExtractableClass } from '@/lib/analytics/pipeline/sources';
import type { StoredEpisode } from '@/lib/analytics/pipeline/types';
import type { TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';

const INSERT_BATCH = 500;
/** 추출 창 시작에 걸린(open) 에피소드는 앞 구간 에피소드의 잘린 조각이므로 저장하지 않는다 */
export const OPEN_EDGE_MS = 10 * 60_000;

const ALL_KINDS: readonly EpisodeKind[] = Object.values(EPISODE_KINDS).flat();
const iso = (ms: number): string => new Date(ms).toISOString();

export const kindsOfClass = (classKey: ExtractableClass): readonly EpisodeKind[] => EPISODE_KINDS[classKey];

/** 겹침 재처리 시작 시각: 요청 시작 − overlap 이전에 시작해 그 뒤에 끝난 open 에피소드가 있으면 그 시작부터 다시 뽑는다 */
export async function extractionStart(db: Kysely<DB>, assetId: number, proposedStart: number): Promise<number> {
  const { rows } = await sql<{ start_ms: number | null }>`
    SELECT (extract(epoch FROM min(start_ts)) * 1000)::float8 AS start_ms
    FROM om.episode
    WHERE asset_id = ${assetId} AND invalid_reason = 'open' AND start_ts < ${iso(proposedStart)}::timestamptz AND end_ts >= ${iso(proposedStart)}::timestamptz
  `.execute(db);
  const openStart = rows[0]?.start_ms ?? null;
  return openStart === null ? proposedStart : Math.min(proposedStart, openStart);
}

/** 저장할 에피소드: 창 시작 경계에 걸린 open 조각은 뺀다 */
export const storableEpisodes = (episodes: readonly StoredEpisode[], window: TimeWindow): StoredEpisode[] =>
  episodes.filter((e) => !(e.open && e.start - window.start <= OPEN_EDGE_MS) && e.start >= window.start && e.start < window.end);

/** 설비 하나의 [window) 에피소드를 지우고 새로 넣는다 (한 트랜잭션). 넣은 행 수를 돌려준다 */
export async function replaceEpisodes(db: Kysely<DB>, assetId: number, kinds: readonly EpisodeKind[], window: TimeWindow, episodes: readonly StoredEpisode[], runId: string): Promise<number> {
  const rows = storableEpisodes(episodes, window).map((e) => ({
    asset_id: assetId,
    kind: e.kind,
    start_ts: iso(e.start),
    end_ts: iso(e.end),
    extractor_version: e.extractorVersion,
    features: JSON.stringify(e.features),
    conditions: JSON.stringify(e.conditions),
    dq: JSON.stringify(e.dq),
    valid: e.valid,
    invalid_reason: e.invalidReason,
    run_id: runId,
  }));
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('om.episode').where('asset_id', '=', assetId).where('kind', 'in', [...kinds]).where('start_ts', '>=', new Date(window.start)).where('start_ts', '<', new Date(window.end)).execute();
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await trx
        .insertInto('om.episode')
        .values(rows.slice(i, i + INSERT_BATCH))
        .onConflict((oc) =>
          oc.columns(['asset_id', 'kind', 'start_ts']).doUpdateSet((eb) => ({
            end_ts: eb.ref('excluded.end_ts'),
            extractor_version: eb.ref('excluded.extractor_version'),
            features: eb.ref('excluded.features'),
            conditions: eb.ref('excluded.conditions'),
            dq: eb.ref('excluded.dq'),
            valid: eb.ref('excluded.valid'),
            invalid_reason: eb.ref('excluded.invalid_reason'),
            run_id: eb.ref('excluded.run_id'),
          })),
        )
        .execute();
    }
  });
  return rows.length;
}

interface EpisodeSqlRow {
  readonly asset_id: number;
  readonly kind: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly extractor_version: string;
  readonly features: unknown;
  readonly conditions: unknown;
  readonly dq: unknown;
  readonly valid: boolean;
  readonly invalid_reason: string | null;
}

/** 저장한 에피소드 (현재 추출기 버전, until 이전에 끝난 것). jsonb는 이 모듈이 넣은 형태 그대로 되돌린다 */
export async function loadEpisodes(db: Kysely<DB>, assetIds: readonly number[], until: number): Promise<StoredEpisode[]> {
  if (assetIds.length === 0) return [];
  const versions = ALL_KINDS.map(extractorId);
  const { rows } = await sql<EpisodeSqlRow>`
    SELECT asset_id, kind, (extract(epoch FROM start_ts) * 1000)::float8 AS start_ms, (extract(epoch FROM end_ts) * 1000)::float8 AS end_ms,
      extractor_version, features, conditions, dq, valid, invalid_reason
    FROM om.episode
    WHERE asset_id = ANY(${[...assetIds]}::int4[]) AND end_ts <= ${iso(until)}::timestamptz AND extractor_version = ANY(${versions}::text[])
    ORDER BY asset_id, kind, start_ts
  `.execute(db);
  return rows.flatMap((row) => {
    if (!(ALL_KINDS as readonly string[]).includes(row.kind)) return [];
    const episode = { assetId: row.asset_id, kind: row.kind, extractorVersion: row.extractor_version, start: row.start_ms, end: row.end_ms, features: row.features, conditions: row.conditions, dq: row.dq, open: row.invalid_reason === 'open', valid: row.valid, invalidReason: row.invalid_reason };
    return [episode as StoredEpisode];
  });
}
