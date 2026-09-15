import 'server-only';
// 탐지기 설정 화면 조회: 설정 버전 이력·활성 범위 수·범위 선택용 설비 목록.
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import type { ConfigVersionRow } from '@/lib/detector-config/history';
import { loadDetectorConfigVersions } from '@/lib/ops/detector-config';

/** 탐지기 하나의 모든 설정 버전 (lib/ops/detector-config.ts loadDetectorConfigVersions) */
export const listDetectorConfigVersions = (detectorId: string): Promise<readonly ConfigVersionRow[]> => loadDetectorConfigVersions(db, detectorId);

/** 탐지기 id → 활성 설정 범위 수 */
export async function activeScopeCounts(): Promise<ReadonlyMap<string, number>> {
  const rows = await db.selectFrom('om.detector_config').select(['detector_id', sql<number>`count(*)::int`.as('n')]).where('active', '=', true).groupBy('detector_id').execute();
  return new Map(rows.map((r) => [r.detector_id, r.n]));
}

export interface ConfigAssetOption {
  readonly id: number;
  readonly siteCode: string;
  readonly code: string;
  readonly name: string;
}

/** asset:<id> 범위 후보 (설비 종류가 맞는 전 사이트 설비, 사이트 → 경로 순) */
export async function listConfigAssets(classKey: string): Promise<readonly ConfigAssetOption[]> {
  const rows = await db
    .selectFrom('om.asset as a')
    .innerJoin('om.site as s', 's.id', 'a.site_id')
    .select(['a.id', 's.code as site_code', 'a.code', 'a.name'])
    .where('a.class_key', '=', classKey)
    .orderBy('s.code')
    .orderBy('a.code')
    .execute();
  return rows.map((r) => ({ id: r.id, siteCode: r.site_code, code: r.code, name: r.name }));
}

/** 설정 범위에 나온 설비 id → 'SIM-A · ESS1/RACK01' */
export async function assetScopeNames(assetIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db.selectFrom('om.asset as a').innerJoin('om.site as s', 's.id', 'a.site_id').select(['a.id', 's.code as site_code', 'a.code']).where('a.id', 'in', [...assetIds]).execute();
  return new Map(rows.map((r) => [r.id, `${r.site_code} · ${r.code}`]));
}
