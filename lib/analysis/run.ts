// 수동 분석 실행 (설계 §0: 관리자가 사이트·설비·기간을 골라 "분석 실행" → 결과는 finding으로만 저장, 리포트는 만들지 않음).
//   analysis_run 기록 → 사이트별 advisory 잠금 → 중단된 이전 실행 정리 → 남은 dirty 롤업 → 사이트마다 runSite → 실행 통계·상태
// 'server-only'를 넣지 않는다: npm run analyze와 integration 테스트에서도 쓴다. 호출 전 관리자 확인은 Server Action이 한다.
import type { Kysely } from 'kysely';
import * as z from 'zod';
import type { DB } from '@/lib/db/types';
import { drainDirty } from '@/lib/ingest/rollup';
import { loadActiveDetectorConfigs, loadSitePoints, loadSites } from './catalog';
import { failAbandonedRuns, withSiteLocks } from './lock';
import { runSite, type RunError, type SiteRunContext, type SiteRunStats } from './site-run';

export const DEFAULT_TIME_BUDGET_MS = 15 * 60_000;
export const DEFAULT_OVERLAP_HOURS = 6;
/** 한 번에 분석할 수 있는 최대 기간 */
export const MAX_ANALYSIS_DAYS = 400;
const ROLLUP_LIMIT = 5_000;

export const analysisRequestSchema = z
  .object({
    siteIds: z.array(z.number().int().positive()).min(1, '사이트를 하나 이상 고르세요').refine((ids) => new Set(ids).size === ids.length, '사이트가 중복되었습니다'),
    assetIds: z.array(z.number().int().positive()).min(1).optional(),
    from: z.date(),
    to: z.date(),
    requestedBy: z.string().trim().min(1, '요청자가 필요합니다'),
  })
  .refine((r) => r.to.getTime() > r.from.getTime(), { error: '끝 시각은 시작 시각보다 늦어야 합니다', path: ['to'] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_ANALYSIS_DAYS * 86_400_000, { error: `분석 기간은 ${MAX_ANALYSIS_DAYS}일 이하여야 합니다`, path: ['from'] });

export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

export interface RunAnalysisOptions {
  readonly now?: () => Date;
  readonly timeBudgetMs?: number;
  readonly overlapHours?: number;
  /** 부트스트랩 난수 시드 (같은 입력·시드 → 같은 CI) */
  readonly seed?: number;
  readonly log?: (message: string) => void;
  /** 'verify': 롤업·에피소드 추출·KPI·탐지를 건너뛰고 저장된 에피소드로 조치 효과 검증만 한다 (조치 추적의 "검증만 실행") */
  readonly stages?: 'all' | 'verify';
}

export type AnalysisStatus = 'succeeded' | 'partial' | 'failed';

export interface AnalysisRunStats {
  readonly sites: readonly SiteRunStats[];
  readonly rollup: { readonly picked: number; readonly upserted: number };
  readonly abandonedRunsFailed: number;
  readonly budgetExceeded: boolean;
  readonly errors: readonly RunError[];
  readonly elapsedMs: number;
}

export interface AnalysisRunResult {
  readonly runId: string;
  readonly status: AnalysisStatus;
  readonly stats: AnalysisRunStats;
}

export class AnalysisBusyError extends Error {
  constructor(
    readonly runId: string,
    readonly siteId: number,
  ) {
    super(`사이트(id ${siteId})의 분석이 이미 진행 중입니다. 끝난 뒤 다시 실행하세요`);
    this.name = 'AnalysisBusyError';
  }
}

async function finishRun(db: Kysely<DB>, runId: string, status: AnalysisStatus, stats: object, error: string | null, now: Date): Promise<void> {
  await db.updateTable('om.analysis_run').set({ status, finished_at: now, stats: JSON.stringify(stats), error }).where('id', '=', runId).where('status', '=', 'running').execute();
}

const statusOf = (stats: AnalysisRunStats): AnalysisStatus => (stats.errors.length > 0 || stats.budgetExceeded ? 'partial' : 'succeeded');

async function execute(db: Kysely<DB>, request: AnalysisRequest, runId: string, startedAt: Date, options: RunAnalysisOptions): Promise<AnalysisRunStats> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const abandoned = await failAbandonedRuns(db, runId, request.siteIds, new Date(now().getTime() - 2 * budgetMs));
  const sites = await loadSites(db, request.siteIds);
  if (sites.length !== request.siteIds.length) throw new Error(`없는 사이트가 있습니다: ${request.siteIds.filter((id) => !sites.some((s) => s.id === id)).join(', ')}`);
  const verifyOnly = options.stages === 'verify';
  const pointIds = verifyOnly ? [] : (await Promise.all(sites.map((s) => loadSitePoints(db, s.id)))).flat().map((p) => p.pointId);
  const rollup = verifyOnly ? { picked: 0, upserted: 0 } : await drainDirty(db, { limit: ROLLUP_LIMIT, maxRounds: 1_000, pointIds });
  if (!verifyOnly) log(`남은 dirty 롤업 ${rollup.picked}개 처리`);

  const errors: RunError[] = []; // 실행 동안 단계별 오류를 모으는 누적 목록 (이 함수 안에서만 채운다)
  const ctx: SiteRunContext = {
    db,
    runId,
    window: { start: request.from.getTime(), end: request.to.getTime() },
    assetIds: request.assetIds ? new Set(request.assetIds) : null,
    overlapMs: (options.overlapHours ?? DEFAULT_OVERLAP_HOURS) * 3_600_000,
    seed: options.seed ?? 1,
    configs: await loadActiveDetectorConfigs(db),
    now,
    deadline: startedAt.getTime() + budgetMs,
    errors,
    log,
    verifyOnly,
  };
  const siteStats: SiteRunStats[] = [];
  for (const site of sites) {
    log(`${site.code} 분석 시작`);
    siteStats.push(await runSite(ctx, site));
    log(`${site.code} 분석 끝 (${Math.round((siteStats.at(-1)?.elapsedMs ?? 0) / 1000)}초)`);
  }
  return {
    sites: siteStats,
    rollup: { picked: rollup.picked, upserted: rollup.upserted },
    abandonedRunsFailed: abandoned,
    budgetExceeded: now().getTime() > ctx.deadline || siteStats.some((s) => s.skipped.length > 0),
    errors: [...errors],
    elapsedMs: now().getTime() - startedAt.getTime(),
  };
}

/** 분석을 실행한다. 같은 사이트 분석이 진행 중이면 실행 행을 failed로 남기고 AnalysisBusyError */
export async function runAnalysis(db: Kysely<DB>, input: AnalysisRequest, options: RunAnalysisOptions = {}): Promise<AnalysisRunResult> {
  const request = analysisRequestSchema.parse(input);
  const now = options.now ?? (() => new Date());
  const scope = { siteIds: request.siteIds, ...(request.assetIds ? { assetIds: request.assetIds } : {}), from: request.from.toISOString(), to: request.to.toISOString(), ...(options.stages === 'verify' ? { mode: 'verify' } : {}) };
  const run = await db.insertInto('om.analysis_run').values({ requested_by: request.requestedBy, scope: JSON.stringify(scope), started_at: now() }).returning(['id', 'started_at']).executeTakeFirstOrThrow();

  let outcome;
  try {
    outcome = await withSiteLocks(db, request.siteIds, () => execute(db, request, run.id, run.started_at, options));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await finishRun(db, run.id, 'failed', { error: text }, text, now());
    return { runId: run.id, status: 'failed', stats: { sites: [], rollup: { picked: 0, upserted: 0 }, abandonedRunsFailed: 0, budgetExceeded: false, errors: [{ stage: 'run', siteId: request.siteIds[0] ?? 0, message: text }], elapsedMs: now().getTime() - run.started_at.getTime() } };
  }
  if (!outcome.acquired) {
    const busy = new AnalysisBusyError(run.id, outcome.busySiteId);
    await finishRun(db, run.id, 'failed', { busySiteId: outcome.busySiteId }, busy.message, now());
    throw busy;
  }
  const status = statusOf(outcome.value);
  await finishRun(db, run.id, status, outcome.value, null, now());
  return { runId: run.id, status, stats: outcome.value };
}
