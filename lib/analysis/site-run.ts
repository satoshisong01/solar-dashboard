// 사이트 하나 분석: 에피소드 추출·저장(겹침 재처리) → 일 KPI → 탐지기(P2·P3) → 체인 원장 → 물질수지 → finding 저장 → 조치 효과 검증.
// 설비·탐지기 단위 오류는 기록하고 계속한다 (실행 상태 partial). 시간 예산을 넘으면 남은 단계를 건너뛴다.
// 단계별 소요시간은 stats.stages [ms]에 남긴다.
import { sql, type Kysely } from 'kysely';
import { INVALID_CONFIG } from '@/lib/analytics/pipeline/config';
import { extractAssetEpisodes, stackRunningCurrentA } from '@/lib/analytics/pipeline/extract';
import { dailyKpiRows, type KpiRow } from '@/lib/analytics/pipeline/kpis';
import { isExtractable, seriesRequests } from '@/lib/analytics/pipeline/sources';
import type { DetectorConfigRow, DetectorOutcome, PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { KPI_CALC_VERSION } from '@/lib/analytics/kpi/daily';
import { kstDayStart, MS_PER_HOUR, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import { loadSiteAssets, loadSitePoints, type PointRow, type SiteRow } from './catalog';
import { extractionStart, kindsOfClass, loadEpisodes, replaceEpisodes } from './episodes';
import { EMPTY_PERSIST_STATS, persistFindings, type FindingPersistStats } from './findings';
import type { LedgerStats } from './ledger';
import { loadAssetSeries, loadHourly, loadStackPriorState } from './series';
import { detectSite } from './site-detect';
import { extractTankHoldsWindowed } from './tank-holds';
import { verifyActions, type VerificationStats } from './verification';

/** 원시 조회 앞 여유: 휴지 후 시작 판정(1시간)·직전 SOC·기상값 조회용 */
const SERIES_LEAD_MS = 2 * MS_PER_HOUR;
const MAX_ERRORS = 50;
const MAX_CONFIG_ISSUES = 20;

export interface RunError {
  readonly stage: 'run' | 'extract' | 'kpi' | 'dq' | 'detect' | 'curves' | 'ledger' | 'findings' | 'verify';
  readonly siteId: number;
  readonly assetId?: number;
  readonly detectorId?: string;
  readonly message: string;
}

export type StageKey = 'extract' | 'kpi' | 'aux' | 'detect' | 'ledger' | 'findings' | 'verify';

export interface DetectorTally {
  readonly ok: number;
  readonly insufficient: number;
  readonly error: number;
  readonly findings: number;
  /** insufficient 중 설정 검증 실패 (invalid_config) */
  readonly invalidConfig: number;
}

export interface SiteRunStats {
  readonly siteId: number;
  readonly siteCode: string;
  readonly assets: number;
  readonly extractedAssets: number;
  readonly episodesSaved: number;
  readonly episodesInHistory: number;
  readonly kpiRows: number;
  readonly detectors: Readonly<Record<string, DetectorTally>>;
  /** 설정 검증에 실패한 탐지기 실행 (탐지기·설비·사유) */
  readonly configIssues: readonly { readonly detectorId: string; readonly assetId: number | null; readonly reason: string }[];
  readonly ledger: LedgerStats | null;
  /** tank.hold 추출에서 원시를 읽은 창 수·길이 */
  readonly tankHoldRaw: { readonly windows: number; readonly hours: number };
  readonly findings: FindingPersistStats;
  readonly verification: VerificationStats | null;
  readonly skipped: readonly string[];
  readonly stages: Readonly<Partial<Record<StageKey, number>>>;
  readonly elapsedMs: number;
}

export interface SiteRunContext {
  readonly db: Kysely<DB>;
  readonly runId: string;
  readonly window: TimeWindow;
  readonly assetIds: ReadonlySet<number> | null;
  readonly overlapMs: number;
  readonly seed: number;
  readonly configs: readonly DetectorConfigRow[];
  readonly now: () => Date;
  readonly deadline: number;
  readonly errors: RunError[];
  readonly log: (message: string) => void;
  /** 저장된 에피소드로 조치 효과 검증만 한다 */
  readonly verifyOnly?: boolean;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const recordError = (ctx: SiteRunContext, error: Omit<RunError, 'message'>, cause: unknown): void => {
  if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ ...error, message: message(cause) });
};
const overBudget = (ctx: SiteRunContext): boolean => ctx.now().getTime() > ctx.deadline;

/** 단계별 소요시간 누적기 (실행 하나 안에서만 쓰는 가변 기록) */
function stageTimer(ctx: SiteRunContext) {
  const stages: Partial<Record<StageKey, number>> = {};
  const time = async <T>(stage: StageKey, work: () => Promise<T>): Promise<T> => {
    const started = ctx.now().getTime();
    try {
      return await work();
    } finally {
      stages[stage] = (stages[stage] ?? 0) + ctx.now().getTime() - started;
    }
  };
  return { stages, time };
}

/** 스택이면 창 시작 전 운전 상태(끝 구간만 다시 추출해도 창 첫 기동의 꺼짐 시간을 잃지 않게), 아니면 null */
async function stackPrior(ctx: SiteRunContext, asset: PipelineAsset, points: readonly PointRow[], windowStart: number) {
  const runningA = stackRunningCurrentA(asset);
  const currentPoint = points.find((p) => p.assetId === asset.id && p.metricKey === 'stack.current');
  return runningA === null || !currentPoint ? null : loadStackPriorState(ctx.db, currentPoint.pointId, windowStart, runningA);
}

interface AssetExtraction {
  readonly saved: number;
  readonly rawWindows: number;
  readonly rawHours: number;
}

async function extractAsset(ctx: SiteRunContext, asset: PipelineAsset, assets: readonly PipelineAsset[], points: readonly PointRow[]): Promise<AssetExtraction> {
  if (!isExtractable(asset.classKey)) return { saved: 0, rawWindows: 0, rawHours: 0 };
  const start = await extractionStart(ctx.db, asset.id, kstDayStart(ctx.window.start - ctx.overlapMs));
  const window = { start, end: ctx.window.end };
  if (asset.classKey === 'h2.storage.tank') {
    const holds = await extractTankHoldsWindowed(ctx.db, asset, assets, points, window);
    return { saved: await replaceEpisodes(ctx.db, asset.id, kindsOfClass(asset.classKey), window, holds.episodes, ctx.runId), rawWindows: holds.windows, rawHours: holds.rawHours };
  }
  const series = await loadAssetSeries(ctx.db, seriesRequests(asset, assets), points, { start: start - SERIES_LEAD_MS, end: window.end });
  const episodes = extractAssetEpisodes(asset, series, window, {}, { stackPrior: await stackPrior(ctx, asset, points, start) });
  return { saved: await replaceEpisodes(ctx.db, asset.id, kindsOfClass(asset.classKey), window, episodes, ctx.runId), rawWindows: 0, rawHours: 0 };
}

async function upsertKpis(db: Kysely<DB>, rows: readonly KpiRow[]): Promise<number> {
  const values = rows.map((row) => ({
    scope_type: row.scopeType,
    scope_id: row.scopeId,
    day: row.day,
    kpi_key: row.kpi.key,
    value: row.kpi.value !== null && Number.isFinite(row.kpi.value) ? row.kpi.value : null,
    unit: row.kpi.unit,
    n: row.kpi.n,
    dq_completeness: row.kpi.dqCompleteness === null || !Number.isFinite(row.kpi.dqCompleteness) ? null : Math.min(1, Math.max(0, row.kpi.dqCompleteness)),
    calc_version: KPI_CALC_VERSION,
  }));
  for (let i = 0; i < values.length; i += 1_000) {
    await db
      .insertInto('om.kpi_daily')
      .values(values.slice(i, i + 1_000).map((v) => ({ ...v, day: sql<Date>`${v.day}::date` })))
      .onConflict((oc) => oc.columns(['scope_type', 'scope_id', 'day', 'kpi_key']).doUpdateSet((eb) => ({ value: eb.ref('excluded.value'), unit: eb.ref('excluded.unit'), n: eb.ref('excluded.n'), dq_completeness: eb.ref('excluded.dq_completeness'), calc_version: eb.ref('excluded.calc_version') })))
      .execute();
  }
  return values.length;
}

function tallyDetectors(outcomes: readonly DetectorOutcome[]): SiteRunStats['detectors'] {
  const tally: Record<string, DetectorTally> = {};
  for (const o of outcomes) {
    const current = tally[o.detectorId] ?? { ok: 0, insufficient: 0, error: 0, findings: 0, invalidConfig: 0 };
    const invalid = o.reason?.startsWith(INVALID_CONFIG) ? 1 : 0;
    tally[o.detectorId] = { ...current, [o.status]: current[o.status] + 1, findings: current.findings + o.findings.length, invalidConfig: current.invalidConfig + invalid };
  }
  return tally;
}

const configIssuesOf = (outcomes: readonly DetectorOutcome[]): SiteRunStats['configIssues'] =>
  outcomes.filter((o) => o.reason?.startsWith(INVALID_CONFIG)).slice(0, MAX_CONFIG_ISSUES).map((o) => ({ detectorId: o.detectorId, assetId: o.assetId, reason: o.reason ?? '' }));

interface SiteData {
  readonly site: SiteRow;
  readonly assets: readonly PipelineAsset[];
  readonly targets: readonly PipelineAsset[];
  readonly points: readonly PointRow[];
}

/** 대상 설비 에피소드 추출·저장. 시간 예산을 넘은 설비는 건너뛴다 */
async function extractSite(ctx: SiteRunContext, data: SiteData): Promise<{ extractedAssets: number; episodesSaved: number; skipped: string[]; tankHoldRaw: SiteRunStats['tankHoldRaw'] }> {
  const skipped: string[] = [];
  let extractedAssets = 0;
  let episodesSaved = 0;
  let tankHoldRaw = { windows: 0, hours: 0 };
  for (const asset of data.targets.filter((a) => isExtractable(a.classKey))) {
    if (overBudget(ctx)) {
      skipped.push(`extract:${asset.code}`);
      continue;
    }
    try {
      const result = await extractAsset(ctx, asset, data.assets, data.points);
      episodesSaved += result.saved;
      tankHoldRaw = { windows: tankHoldRaw.windows + result.rawWindows, hours: tankHoldRaw.hours + result.rawHours };
      extractedAssets += 1;
    } catch (error) {
      recordError(ctx, { stage: 'extract', siteId: data.site.id, assetId: asset.id }, error);
    }
  }
  return { extractedAssets, episodesSaved, skipped, tankHoldRaw: { windows: tankHoldRaw.windows, hours: Math.round(tankHoldRaw.hours * 10) / 10 } };
}

async function computeKpis(ctx: SiteRunContext, data: SiteData, history: readonly StoredEpisode[]): Promise<number> {
  try {
    const window = { start: kstDayStart(ctx.window.start), end: ctx.window.end };
    const kpiPoints = data.points.filter((p) => data.targets.some((a) => a.id === p.assetId && ((a.classKey === 'pv.inverter' && p.metricKey === 'ac.power') || (a.classKey === 'ess.rack' && p.metricKey === 'batt.soc'))));
    const hourly = await loadHourly(ctx.db, kpiPoints, window);
    return await upsertKpis(ctx.db, dailyKpiRows({ siteId: data.site.id, assets: data.targets, episodes: history.filter((e) => e.start >= window.start), hourly, window }));
  } catch (error) {
    recordError(ctx, { stage: 'kpi', siteId: data.site.id }, error);
    return 0;
  }
}

async function verifySite(ctx: SiteRunContext, site: SiteRow): Promise<SiteRunStats> {
  const started = ctx.now().getTime();
  const assets = await loadSiteAssets(ctx.db, site.id);
  const targets = assets.filter((a) => ctx.assetIds === null || ctx.assetIds.has(a.id));
  const history = await loadEpisodes(ctx.db, targets.filter((a) => isExtractable(a.classKey)).map((a) => a.id), ctx.window.end);
  const verification = await verifyActions(ctx.db, { runId: ctx.runId, siteId: site.id, assetIds: ctx.assetIds, until: ctx.window.end, episodes: history, assets, seed: ctx.seed }).catch((error: unknown) => {
    recordError(ctx, { stage: 'verify', siteId: site.id }, error);
    return null;
  });
  const elapsedMs = ctx.now().getTime() - started;
  return { siteId: site.id, siteCode: site.code, assets: targets.length, extractedAssets: 0, episodesSaved: 0, episodesInHistory: history.length, kpiRows: 0, detectors: {}, configIssues: [], ledger: null, tankHoldRaw: { windows: 0, hours: 0 }, findings: EMPTY_PERSIST_STATS, verification, skipped: [], stages: { verify: elapsedMs }, elapsedMs };
}

export async function runSite(ctx: SiteRunContext, site: SiteRow): Promise<SiteRunStats> {
  if (ctx.verifyOnly) return verifySite(ctx, site);
  const started = ctx.now().getTime();
  const { stages, time } = stageTimer(ctx);
  const [assets, points] = await Promise.all([loadSiteAssets(ctx.db, site.id), loadSitePoints(ctx.db, site.id)]);
  const data: SiteData = { site, assets, points, targets: assets.filter((a) => ctx.assetIds === null || ctx.assetIds.has(a.id)) };
  const extraction = await time('extract', () => extractSite(ctx, data));
  const base = { siteId: site.id, siteCode: site.code, assets: data.targets.length, extractedAssets: extraction.extractedAssets, episodesSaved: extraction.episodesSaved, tankHoldRaw: extraction.tankHoldRaw };
  if (overBudget(ctx)) {
    ctx.log(`${site.code}: 시간 예산 초과로 KPI·탐지·검증을 건너뜁니다`);
    return { ...base, episodesInHistory: 0, kpiRows: 0, detectors: {}, configIssues: [], ledger: null, findings: EMPTY_PERSIST_STATS, verification: null, skipped: [...extraction.skipped, 'kpi', 'detect', 'verify'], stages: { ...stages }, elapsedMs: ctx.now().getTime() - started };
  }
  const history = await loadEpisodes(ctx.db, assets.filter((a) => isExtractable(a.classKey)).map((a) => a.id), ctx.window.end);
  const kpiRows = await time('kpi', () => computeKpis(ctx, data, history));
  const detected = await detectSite(
    {
      ...ctx,
      onError: (stage, error, detail) => recordError(ctx, { stage, siteId: site.id, ...detail }, error),
      time: (stage, work) => time(stage, work),
    },
    { site, assets, points, history },
  ).catch((error: unknown) => {
    recordError(ctx, { stage: 'detect', siteId: site.id }, error);
    return { outcomes: [], ledger: null };
  });
  detected.outcomes.filter((o) => o.status === 'error').forEach((o) => recordError(ctx, { stage: 'detect', siteId: site.id, assetId: o.assetId ?? undefined, detectorId: o.detectorId }, o.reason));
  const findings = await time('findings', () => persistFindings(ctx.db, { runId: ctx.runId, siteId: site.id, outcomes: detected.outcomes, now: ctx.now() })).catch((error: unknown) => {
    recordError(ctx, { stage: 'findings', siteId: site.id }, error);
    return EMPTY_PERSIST_STATS;
  });
  const verification = await time('verify', () => verifyActions(ctx.db, { runId: ctx.runId, siteId: site.id, assetIds: ctx.assetIds, until: ctx.window.end, episodes: history, assets, seed: ctx.seed })).catch((error: unknown) => {
    recordError(ctx, { stage: 'verify', siteId: site.id }, error);
    return null;
  });
  return {
    ...base,
    episodesInHistory: history.length,
    kpiRows,
    detectors: tallyDetectors(detected.outcomes),
    configIssues: configIssuesOf(detected.outcomes),
    ledger: detected.ledger,
    findings,
    verification,
    skipped: extraction.skipped,
    stages: { ...stages },
    elapsedMs: ctx.now().getTime() - started,
  };
}
