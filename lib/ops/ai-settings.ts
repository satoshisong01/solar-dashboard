// AI 설명 사용 여부 (om.ai_explanation_setting). 전역 행 하나 + 사이트 행(있으면 그 사이트에서 앞선다).
// 행이 없으면 키가 있을 때 켠 것으로 본다 — 키를 넣자마자 쓸 수 있고, 끄고 싶으면 명시적으로 끈다.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 권한 확인은 Server Action이 한다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';

export interface AiSettingRow {
  /** null = 전역 */
  readonly siteId: number | null;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly updatedAtMs: number;
}

export interface AiSettings {
  /** 전역값 (설정한 적 없으면 null) */
  readonly global: boolean | null;
  /** 사이트 id → 사이트값 (전역을 따르면 키가 없다) */
  readonly bySite: ReadonlyMap<number, boolean>;
  readonly rows: readonly AiSettingRow[];
}

export async function readAiSettings(db: Kysely<DB>): Promise<AiSettings> {
  const rows = await db.selectFrom('om.ai_explanation_setting').select(['site_id', 'enabled', 'updated_by', 'updated_at']).execute();
  const items = rows.map((row): AiSettingRow => ({ siteId: row.site_id, enabled: row.enabled, updatedBy: row.updated_by, updatedAtMs: row.updated_at.getTime() }));
  return {
    global: items.find((row) => row.siteId === null)?.enabled ?? null,
    bySite: new Map(items.flatMap((row) => (row.siteId === null ? [] : [[row.siteId, row.enabled] as const]))),
    rows: items,
  };
}

/** 이 사이트에서 AI 설명을 쓰는가: 사이트값 > 전역값 > 키가 있으면 켬 */
export function aiEnabledFor(settings: AiSettings, siteId: number, hasKey: boolean): boolean {
  return settings.bySite.get(siteId) ?? settings.global ?? hasKey;
}

/** 전역값 저장 (site_id NULL 행 하나를 upsert) */
export async function setGlobalAiSetting(db: Kysely<DB>, input: Readonly<{ enabled: boolean; actor: string }>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('om.ai_explanation_setting').where('site_id', 'is', null).execute();
    await trx.insertInto('om.ai_explanation_setting').values({ site_id: null, enabled: input.enabled, updated_by: input.actor, updated_at: new Date() }).execute();
  });
}

/** 사이트값 저장. enabled가 null이면 행을 지워 전역을 따르게 한다 */
export async function setSiteAiSetting(db: Kysely<DB>, input: Readonly<{ siteId: number; enabled: boolean | null; actor: string }>): Promise<void> {
  const { siteId, enabled, actor } = input;
  if (enabled === null) {
    await db.deleteFrom('om.ai_explanation_setting').where('site_id', '=', siteId).execute();
    return;
  }
  const updatedAt = new Date();
  await db
    .insertInto('om.ai_explanation_setting')
    .values({ site_id: siteId, enabled, updated_by: actor, updated_at: updatedAt })
    .onConflict((oc) => oc.column('site_id').where('site_id', 'is not', null).doUpdateSet({ enabled, updated_by: actor, updated_at: updatedAt }))
    .execute();
}
