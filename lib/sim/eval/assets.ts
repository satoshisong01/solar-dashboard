// 평가용 설비 목록: 가상 사이트 정의(db/seed/sites)를 DB 없이 분석 파이프라인 설비로 바꾼다.
// id는 사이트 순번·설비 순번으로 정한 결정적 값이다 (DB id와 무관).
import { SIM_SITES } from '@/db/seed/sites';
import type { SiteDef } from '@/db/seed/types';
import type { AssetEventRow, PipelineAsset } from '@/lib/analytics/pipeline/types';
import type { AssetEventTruth } from '../truth';

export interface EvalSite {
  readonly siteId: number;
  readonly site: SiteDef;
  readonly assets: readonly PipelineAsset[];
  /** `${사이트}/${설비 코드}` → 설비 */
  readonly byPath: ReadonlyMap<string, PipelineAsset>;
}

const kstDateMs = (date: string): number => Date.parse(`${date}T00:00:00+09:00`);
const parentCode = (code: string): string | null => (code.includes('/') ? code.slice(0, code.lastIndexOf('/')) : null);

export function evalSite(siteCode: string): EvalSite {
  const index = SIM_SITES.findIndex((s) => s.code === siteCode);
  const site = SIM_SITES[index];
  if (!site) throw new Error(`알 수 없는 가상 사이트: ${siteCode}`);
  const siteId = index + 1;
  const idOf = new Map(site.assets.map((a, i) => [a.code, siteId * 1_000 + i + 1]));
  const assets = site.assets.map((a): PipelineAsset => {
    const parent = parentCode(a.code);
    return {
      id: idOf.get(a.code) ?? 0,
      siteId,
      parentId: parent === null ? null : (idOf.get(parent) ?? null),
      code: a.code,
      classKey: a.classKey,
      peerGroup: a.peerGroup,
      nameplate: a.nameplate,
      commissionedAt: a.commissionedAt === null ? null : kstDateMs(a.commissionedAt),
    };
  });
  return { siteId, site, assets, byPath: new Map(assets.map((a) => [`${site.code}/${a.code}`, a])) };
}

/** 정답의 운영 이벤트(asset_event로 넣을 것) → 파이프라인 이벤트 */
export function assetEventsOf(site: EvalSite, events: readonly AssetEventTruth[]): AssetEventRow[] {
  return events.flatMap((e) => {
    const asset = site.byPath.get(e.assetPath);
    return asset ? [{ assetId: asset.id, ts: e.ts, kind: e.kind, resetsBaseline: e.resetsBaseline, note: e.note }] : [];
  });
}
