import 'server-only';
import { ABANDONED_AFTER_MS } from '@/lib/analysis/run';
import { EXTRACTABLE_CLASSES } from '@/lib/analytics/pipeline/sources';
import { db } from '@/lib/db/kysely';
import { parseRunProgress, parseRunScope, runProgressText, summarizeRunStats, unfinishedSiteIds, type RunSummary } from '@/lib/desk/run-summary';

export interface RunHistoryRow {
  readonly id: string;
  readonly requestedBy: string;
  readonly status: string;
  readonly startedMs: number;
  readonly finishedMs: number | null;
  readonly siteCodes: readonly string[];
  /** 설비를 골라 실행했으면 그 수, 사이트 전체면 null */
  readonly assetCount: number | null;
  readonly verifyOnly: boolean;
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
      verifyOnly: scope.verifyOnly,
      fromMs: scope.fromMs,
      toMs: scope.toMs,
      summary: summarizeRunStats(run.stats),
      error: run.error,
    };
  });
}

/**
 * 마지막으로 끝난 분석 실행 시각 (실패한 실행은 빼고, 없으면 null).
 * 열린 발견사항이 0건일 때 "언제까지 본 결과인가"를 밝히는 데 쓴다.
 */
export async function getLastRunFinishedMs(): Promise<number | null> {
  const row = await db
    .selectFrom('om.analysis_run')
    .select('finished_at')
    .where('status', 'in', ['succeeded', 'partial'])
    .orderBy('finished_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.finished_at ? row.finished_at.getTime() : null;
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

/** 분석 데스크 진행 표시가 읽는 실행 하나의 상태 */
export interface RunStatusView {
  readonly id: string;
  readonly status: string;
  readonly startedMs: number;
  readonly finishedMs: number | null;
  readonly siteCodes: readonly string[];
  /** 실행 중일 때의 현재 위치: 'SIM-B (2/4) · 탐지' */
  readonly progressText: string;
  readonly summary: RunSummary;
  readonly error: string | null;
  /** '이어서 실행'으로 다시 돌릴 사이트. 시간 예산을 넘긴 partial일 때만 채운다 */
  readonly resumeSiteCodes: readonly string[];
}

const RUN_STATUS_COLUMNS = ['id', 'status', 'started_at', 'finished_at', 'scope', 'stats', 'error'] as const;

type RunStatusRow = Readonly<{ id: string; status: string; started_at: Date; finished_at: Date | null; scope: unknown; stats: unknown; error: string | null }>;

async function statusView(run: RunStatusRow): Promise<RunStatusView> {
  const scope = parseRunScope(run.scope);
  const unfinished = run.status === 'partial' && !scope.verifyOnly ? unfinishedSiteIds(scope, run.stats) : [];
  const ids = [...new Set(scope.siteIds)];
  const sites = ids.length === 0 ? [] : await db.selectFrom('om.site').select(['id', 'code']).where('id', 'in', ids).execute();
  const codeOf = new Map(sites.map((site) => [site.id, site.code]));
  const label = (id: number) => codeOf.get(id) ?? `#${id}`;
  return {
    id: run.id,
    status: run.status,
    startedMs: run.started_at.getTime(),
    finishedMs: run.finished_at === null ? null : run.finished_at.getTime(),
    siteCodes: scope.siteIds.map(label),
    progressText: runProgressText(parseRunProgress(run.stats)),
    summary: summarizeRunStats(run.stats),
    error: run.error,
    resumeSiteCodes: unfinished.map(label),
  };
}

/**
 * 화면을 열 때의 진행 표시: 아직 도는 중인 실행이 있으면 그것, 없으면 null.
 * 중단돼 running으로 남은 오래된 행(프로세스가 죽은 경우)은 진행 중으로 보이지 않게 뺀다.
 */
export async function getActiveRun(): Promise<RunStatusView | null> {
  const run = await db
    .selectFrom('om.analysis_run')
    .select([...RUN_STATUS_COLUMNS])
    .where('status', '=', 'running')
    .where('started_at', '>=', new Date(Date.now() - ABANDONED_AFTER_MS))
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return run ? statusView(run) : null;
}

/** 진행 표시 폴링(/api/desk/run-status)이 읽는 실행 하나 */
export async function getRunStatus(runId: string): Promise<RunStatusView | null> {
  const run = await db
    .selectFrom('om.analysis_run')
    .select([...RUN_STATUS_COLUMNS])
    .where('id', '=', runId)
    .executeTakeFirst();
  return run ? statusView(run) : null;
}
