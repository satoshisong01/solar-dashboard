// 정비 조치 CSV 가져오기 DB 계층: 검증용 조회(catalog)와 한 트랜잭션 적용.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 관리자 확인은 Server Action이 한다.
import type { Kysely } from 'kysely';
import { registerMaintenanceActionInTransaction } from '@/lib/analysis/transitions';
import type { DB } from '@/lib/db/types';
import { actionDuplicateKey, checkActionCsv, readActionCsv, type ActionCsvCatalog, type ActionCsvResult, type ActionCsvRow, type RawActionRow } from './action-csv';

const BIGINT_ID = /^[1-9]\d{0,17}$/;

/** CSV 행이 가리키는 사이트·설비·발견사항과 기존 조치만 읽는다 */
export async function loadActionCsvCatalog(db: Kysely<DB>, rows: readonly RawActionRow[]): Promise<ActionCsvCatalog> {
  const siteCodes = [...new Set(rows.map((r) => r.siteCode).filter((c) => c !== ''))];
  const assetPaths = [...new Set(rows.map((r) => r.assetPath).filter((p) => p !== ''))];
  const findingIds = [...new Set(rows.map((r) => r.findingId).filter((id) => BIGINT_ID.test(id)))];
  const [sites, assets, findings] = await Promise.all([
    siteCodes.length === 0 ? [] : db.selectFrom('om.site').select(['id', 'code']).where('code', 'in', siteCodes).execute(),
    assetPaths.length === 0 ? [] : db.selectFrom('om.asset').select(['id', 'site_id', 'path', 'class_key']).where('path', 'in', assetPaths).execute(),
    findingIds.length === 0 ? [] : db.selectFrom('om.finding').select(['id', 'site_id', 'asset_id', 'status', 'detector_id']).where('id', 'in', findingIds).execute(),
  ]);
  const existing =
    assets.length === 0
      ? []
      : await db
          .selectFrom('om.maintenance_action')
          .select(['asset_id', 'action_type', 'performed_at'])
          .where('asset_id', 'in', assets.map((a) => a.id))
          .execute();
  return {
    sites: new Map(sites.map((s) => [s.code, s.id])),
    assets: new Map(assets.map((a) => [a.path, { id: a.id, siteId: a.site_id, classKey: a.class_key }])),
    findings: new Map(findings.map((f) => [f.id, { siteId: f.site_id, assetId: f.asset_id, status: f.status, detectorId: f.detector_id }])),
    existing: new Set(existing.map((e) => actionDuplicateKey(e.asset_id, e.action_type, e.performed_at.getTime()))),
  };
}

/** CSV 전체 검증 (미리보기·적용 공용) */
export async function checkActionCsvText(db: Kysely<DB>, text: string, nowMs: number): Promise<ActionCsvResult> {
  const read = readActionCsv(text);
  return checkActionCsv(text, read.ok ? await loadActionCsvCatalog(db, read.rows) : { sites: new Map(), assets: new Map(), findings: new Map(), existing: new Set() }, nowMs);
}

export interface ApplyCsvResult {
  readonly inserted: number;
  /** 연결한 발견사항을 조치 완료로 옮긴 수 */
  readonly transitioned: number;
  readonly withExpectedEffect: number;
}

/** 검증을 통과한 행을 한 트랜잭션으로 넣는다. 한 행이라도 실패하면 모두 되돌린다 */
export async function applyActionCsvRows(db: Kysely<DB>, rows: readonly ActionCsvRow[], actor: string): Promise<ApplyCsvResult> {
  return db.transaction().execute(async (trx) => {
    let transitioned = 0; // 트랜잭션 안에서만 세는 누적값
    for (const row of rows) {
      const result = await registerMaintenanceActionInTransaction(trx, {
        siteId: row.siteId,
        assetId: row.assetId,
        findingId: row.findingId,
        actionType: row.actionType,
        performedAt: new Date(row.performedAt),
        performedBy: row.performedBy,
        notes: row.notes,
        expectedEffect: row.expectedEffect,
        source: 'csv',
        actor,
      });
      transitioned += result.transition ? 1 : 0;
    }
    return { inserted: rows.length, transitioned, withExpectedEffect: rows.filter((r) => r.expectedEffect !== null).length };
  });
}
