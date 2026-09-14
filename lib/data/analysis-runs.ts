import 'server-only';
import { EXTRACTABLE_CLASSES } from '@/lib/analytics/pipeline/sources';
import { db } from '@/lib/db/kysely';
import { parseRunScope, summarizeRunStats, type RunSummary } from '@/lib/desk/run-summary';

export interface RunHistoryRow {
  readonly id: string;
  readonly requestedBy: string;
  readonly status: string;
  readonly startedMs: number;
  readonly finishedMs: number | null;
  readonly siteCodes: readonly string[];
  /** 설비를 골라 실행했으면 그 수, 사이트 전체면 null */
  readonly assetCount: number | null;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly summary: RunSummary;
  readonly error: string | null;
}

export async function listRecentRuns(limit: number): Promise<readonly RunHistoryRow[]> {
  const [runs, sites] = await Promise.all([
    db.selectFrom('om.analysis_run').select(['id', 'requested_by', 'status', 'started_at', 'finished_at', 'scope', 'stats', 'error']).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit).execute(),
    db.selectFrom('om.site').select(['id', 'code']).execute(),
  ]);
  const codeOf = new Map(sites.map((site) => [site.id, site.code]));
  return runs.map((run) => {
    const scope = parseRunScope(run.scope);
    return {
      id: run.id,
      requestedBy: run.requested_by,
      status: run.status,
      startedMs: run.started_at.getTime(),
      finishedMs: run.finished_at ? run.finished_at.getTime() : null,
      siteCodes: scope.siteIds.map((id) => codeOf.get(id) ?? `#${id}`),
      assetCount: scope.assetIds === null ? null : scope.assetIds.length,
      fromMs: scope.fromMs,
      toMs: scope.toMs,
      summary: summarizeRunStats(run.stats),
      error: run.error,
    };
  });
}

export interface RunSiteOption {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

export interface RunAssetOption {
  readonly id: number;
  readonly siteId: number;
  readonly code: string;
  readonly name: string;
  readonly classKey: string;
}

export interface RunFormOptions {
  readonly sites: readonly RunSiteOption[];
  /** 탐지기가 판정하는 설비 종류(ESS 랙·인버터·전해조·연료전지 스택)만 */
  readonly assets: readonly RunAssetOption[];
}

export async function getRunFormOptions(): Promise<RunFormOptions> {
  const [sites, assets] = await Promise.all([
    db.selectFrom('om.site').select(['id', 'code', 'name']).orderBy('code').execute(),
    db.selectFrom('om.asset').select(['id', 'site_id', 'code', 'name', 'class_key']).where('class_key', 'in', [...EXTRACTABLE_CLASSES]).orderBy('code').execute(),
  ]);
  return {
    sites: sites.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    assets: assets.map((a) => ({ id: a.id, siteId: a.site_id, code: a.code, name: a.name, classKey: a.class_key })),
  };
}
