// 시뮬레이션 정답의 운영 이벤트(예: SOC 상한 설정 변경)를 om.asset_event에 기록한다 (sim:backfill 뒤).
// 게이트웨이 봉투에는 설비 설정 이력이 실리지 않으므로 운영자가 콘솔에 기록하는 것과 같은 행을 스크립트가 넣는다.
// 같은 설비·시각·종류·메모가 이미 있으면 넣지 않는다 (재실행 멱등).
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { AssetEventTruth } from './truth';

export const SIM_EVENT_ACTOR = 'sim:backfill';

export interface AssetEventRecordResult {
  readonly inserted: number;
  readonly existing: number;
  /** DB에 설비가 없어 넣지 못한 설비 경로 */
  readonly missingAssets: readonly string[];
}

export async function recordAssetEvents(db: Kysely<DB>, events: readonly AssetEventTruth[]): Promise<AssetEventRecordResult> {
  let inserted = 0;
  let existing = 0;
  const missingAssets: string[] = [];
  for (const event of events) {
    const asset = await db.selectFrom('om.asset').select('id').where('path', '=', event.assetPath).executeTakeFirst();
    if (!asset) {
      missingAssets.push(event.assetPath);
      continue;
    }
    const ts = new Date(event.ts);
    const found = await db.selectFrom('om.asset_event').select('id').where('asset_id', '=', asset.id).where('ts', '=', ts).where('kind', '=', event.kind).where('note', '=', event.note).executeTakeFirst();
    if (found) {
      existing += 1;
      continue;
    }
    await db.insertInto('om.asset_event').values({ asset_id: asset.id, ts, kind: event.kind, resets_baseline: event.resetsBaseline, note: event.note, created_by: SIM_EVENT_ACTOR }).execute();
    inserted += 1;
  }
  return { inserted, existing, missingAssets };
}
