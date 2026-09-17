// 수동 분석 실행 (설계 §0: 관리자가 사이트·설비·기간을 골라 "분석 실행" → 결과는 finding으로만 저장, 리포트는 만들지 않음).
//   analysis_run 기록 → 사이트별 advisory 잠금 → 중단된 이전 실행 정리 → 남은 dirty 롤업 → 사이트마다 runSite → 실행 통계·상태
// 'server-only'를 넣지 않는다: npm run analyze와 integration 테스트에서도 쓴다. 호출 전 관리자 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import * as z from 'zod';
import type { DB } from '@/lib/db/types';
import type { RunProgress } from '@/lib/desk/run-summary';
import { drainDirty } from '@/lib/ingest/rollup';
import { loadActiveDetectorConfigs, loadSitePoints, loadSites } from './catalog';
import { failAbandonedRuns, withSiteLocks } from './lock';
import { runSite, type RunError, type SiteRunContext, type SiteRunStats } from './site-run';

export const DEFAULT_TIME_BUDGET_MS = 15 * 60_000;
/** 화면에서 시작한 분석의 시간 예산. 페이지 maxDuration(300초)보다 짧게 둬서 플랫폼이 함수를 끊기 전에 스스로 마무리하고 partial로 남긴다 */
export const CONSOLE_TIME_BUDGET_MS = 4 * 60_000;
/** 이보다 오래 running으로 남은 실행 행은 중단된 실행으로 본다 (failAbandonedRuns·진행 표시·중복 실행 검사가 같은 기준을 쓴다) */
export const ABANDONED_AFTER_MS = 2 * CONSOLE_TIME_BUDGET_MS;
export const DEFAULT_OVERLAP_HOURS = 6;
/** 한 번에 분석할 수 있는 최대 기간 */
export const MAX_ANALYSIS_DAYS = 400;
const ROLLUP_LIMIT = 5_000;
/** 같은 단계를 연달아 보고할 때(탐지기마다 온다) 진행 표시를 다시 쓰는 최소 간격 */
const PROGRESS_MIN_INTERVAL_MS = 2_000;

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
  /** 진행 상황(사이트·단계)을 받는다. 화면 진행 표시는 progressWriter로 실행 행에 남긴다 */
  readonly onProgress?: (progress: RunProgress) => void;
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
  const report = options.onProgress ?? (() => {});
  const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const abandoned = await failAbandonedRuns(db, runId, request.siteIds, new Date(now().getTime() - 2 * budgetMs));
  const sites = await loadSites(db, request.siteIds);
  if (sites.length !== request.siteIds.length) throw new Error(`없는 사이트가 있습니다: ${request.siteIds.filter((id) => !sites.some((s) => s.id === id)).join(', ')}`);
  const verifyOnly = options.stages === 'verify';
  const pointIds = verifyOnly ? [] : (await Promise.all(sites.map((s) => loadSitePoints(db, s.id)))).flat().map((p) => p.pointId);
  if (!verifyOnly) report({ siteCode: null, siteIndex: 0, siteCount: sites.length, stage: 'rollup', atMs: now().getTime() });
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
  for (const [index, site] of sites.entries()) {
    const onStage = (stage: string) => report({ siteCode: site.code, siteIndex: index + 1, siteCount: sites.length, stage, atMs: now().getTime() });
    log(`${site.code} 분석 시작`);
    onStage(verifyOnly ? 'verify' : 'extract');
    siteStats.push(await runSite({ ...ctx, onStage }, site));
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

export interface PreparedRun {
  readonly runId: string;
  readonly startedAt: Date;
  readonly request: AnalysisRequest;
}

/**
 * 실행 행(running)만 만들고 곧바로 돌아온다. 실제 계산은 executeAnalysisRun이 한다.
 * 화면은 이 둘을 나눠 써서(만들기 → 응답 → after()로 실행하기) 분석이 도는 동안에도 다른 화면으로 옮길 수 있다.
 */
export async function createAnalysisRun(db: Kysely<DB>, input: AnalysisRequest, options: RunAnalysisOptions = {}): Promise<PreparedRun> {
  const request = analysisRequestSchema.parse(input);
  const now = options.now ?? (() => new Date());
  const scope = { siteIds: request.siteIds, ...(request.assetIds ? { assetIds: request.assetIds } : {}), from: request.from.toISOString(), to: request.to.toISOString(), ...(options.stages === 'verify' ? { mode: 'verify' } : {}) };
  const run = await db.insertInto('om.analysis_run').values({ requested_by: request.requestedBy, scope: JSON.stringify(scope), started_at: now() }).returning(['id', 'started_at']).executeTakeFirstOrThrow();
  return { runId: run.id, startedAt: run.started_at, request };
}

/** 만들어 둔 실행 행으로 계산한다. 같은 사이트 분석이 진행 중이면 그 행을 failed로 남기고 AnalysisBusyError */
export async function executeAnalysisRun(db: Kysely<DB>, prepared: PreparedRun, options: RunAnalysisOptions = {}): Promise<AnalysisRunResult> {
  const { runId, startedAt, request } = prepared;
  const now = options.now ?? (() => new Date());

  let outcome;
  try {
    outcome = await withSiteLocks(db, request.siteIds, () => execute(db, request, runId, startedAt, options));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await finishRun(db, runId, 'failed', { error: text }, text, now());
    return { runId, status: 'failed', stats: { sites: [], rollup: { picked: 0, upserted: 0 }, abandonedRunsFailed: 0, budgetExceeded: false, errors: [{ stage: 'run', siteId: request.siteIds[0] ?? 0, message: text }], elapsedMs: now().getTime() - startedAt.getTime() } };
  }
  if (!outcome.acquired) {
    const busy = new AnalysisBusyError(runId, outcome.busySiteId);
    await finishRun(db, runId, 'failed', { busySiteId: outcome.busySiteId }, busy.message, now());
    throw busy;
  }
  const status = statusOf(outcome.value);
  await finishRun(db, runId, status, outcome.value, null, now());
  return { runId, status, stats: outcome.value };
}

/** 만들고 끝까지 기다린다 (npm run analyze·통합 테스트). 화면은 executeAnalysisRun을 응답 뒤로 미룬다 */
export async function runAnalysis(db: Kysely<DB>, input: AnalysisRequest, options: RunAnalysisOptions = {}): Promise<AnalysisRunResult> {
  return executeAnalysisRun(db, await createAnalysisRun(db, input, options), options);
}

/**
 * 진행 상황을 실행 행의 stats.progress에 남기는 onProgress 구현. 실행이 끝나면 stats가 최종 통계로 덮여 사라진다.
 * 실행을 막지 않도록 기다리지 않고 쓰며, 같은 단계를 연달아 보고하면 최소 간격 안에서는 건너뛴다.
 */
export function progressWriter(db: Kysely<DB>, runId: string): (progress: RunProgress) => void {
  let lastKey = '';
  let lastMs = 0;
  return (progress) => {
    const key = `${progress.siteCode}|${progress.stage}`;
    if (key === lastKey && progress.atMs - lastMs < PROGRESS_MIN_INTERVAL_MS) return;
    lastKey = key;
    lastMs = progress.atMs;
    void sql`UPDATE om.analysis_run SET stats = jsonb_set(stats, '{progress}', ${JSON.stringify(progress)}::jsonb, true) WHERE id = ${runId}::int8 AND status = 'running'`
      .execute(db)
      .catch(() => {});
  };
}
