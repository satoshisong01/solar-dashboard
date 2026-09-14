// 사이트 하나 분석: 에피소드 추출·저장(겹침 재처리) → 일 KPI → 탐지기 → finding 저장 → 조치 효과 검증.
// 설비·탐지기 단위 오류는 기록하고 계속한다 (실행 상태 partial). 시간 예산을 넘으면 남은 단계를 건너뛴다.
import { sql, type Kysely } from 'kysely';
import { essCapacityFade } from '@/lib/analytics/detectors/ess-capacity-fade';
import { runSiteDetectors, type DetectOptions } from '@/lib/analytics/pipeline/detect';
import { extractAssetEpisodes, stackRunningCurrentA } from '@/lib/analytics/pipeline/extract';
import { dailyKpiRows, type KpiRow } from '@/lib/analytics/pipeline/kpis';
import { indexSnapshot, type SiteSnapshot } from '@/lib/analytics/pipeline/snapshot';
import { isExtractable, seriesRequests } from '@/lib/analytics/pipeline/sources';
import type { DetectorConfigRow, DetectorOutcome, PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { KPI_CALC_VERSION } from '@/lib/analytics/kpi/daily';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import { loadAssetEvents, loadSiteAssets, loadSitePoints, type PointRow, type SiteRow } from './catalog';
import { loadDqInput } from './dq-summary';
import { extractionStart, kindsOfClass, loadEpisodes, replaceEpisodes } from './episodes';
import { EMPTY_PERSIST_STATS, persistFindings, type FindingPersistStats } from './findings';
import { loadAssetSeries, loadChargeCurves, loadHourly, loadStackPriorState } from './series';
import { verifyActions, type VerificationStats } from './verification';

/** 원시 조회 앞 여유: 휴지 후 시작 판정(1시간)·직전 SOC·기상값 조회용 */
const SERIES_LEAD_MS = 2 * MS_PER_HOUR;
const MAX_ERRORS = 50;

export interface RunError {
  readonly stage: 'run' | 'extract' | 'kpi' | 'dq' | 'detect' | 'curves' | 'findings' | 'verify';
  readonly siteId: number;
  readonly assetId?: number;
  readonly detectorId?: string;
  readonly message: string;
}

export interface SiteRunStats {
  readonly siteId: number;
  readonly siteCode: string;
  readonly assets: number;
  readonly extractedAssets: number;
  readonly episodesSaved: number;
  readonly episodesInHistory: number;
  readonly kpiRows: number;
  readonly detectors: Readonly<Record<string, { ok: number; insufficient: number; error: number; findings: number }>>;
  readonly findings: FindingPersistStats;
  readonly verification: VerificationStats | null;
  readonly skipped: readonly string[];
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

/** 스택이면 창 시작 전 운전 상태(끝 구간만 다시 추출해도 창 첫 기동의 꺼짐 시간을 잃지 않게), 아니면 null */
async function stackPrior(ctx: SiteRunContext, asset: PipelineAsset, points: readonly PointRow[], windowStart: number) {
  const runningA = stackRunningCurrentA(asset);
  const currentPoint = points.find((p) => p.assetId === asset.id && p.metricKey === 'stack.current');
  return runningA === null || !currentPoint ? null : loadStackPriorState(ctx.db, currentPoint.pointId, windowStart, runningA);
}

async function extractAsset(ctx: SiteRunContext, asset: PipelineAsset, assets: readonly PipelineAsset[], points: readonly PointRow[]): Promise<number> {
  if (!isExtractable(asset.classKey)) return 0;
  const start = await extractionStart(ctx.db, asset.id, kstDayStart(ctx.window.start - ctx.overlapMs));
  const window = { start, end: ctx.window.end };
  const series = await loadAssetSeries(ctx.db, seriesRequests(asset, assets), points, { start: start - SERIES_LEAD_MS, end: window.end });
  const episodes = extractAssetEpisodes(asset, series, window, {}, { stackPrior: await stackPrior(ctx, asset, points, start) });
  return replaceEpisodes(ctx.db, asset.id, kindsOfClass(asset.classKey), window, episodes, ctx.runId);
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
  const tally: Record<string, { ok: number; insufficient: number; error: number; findings: number }> = {};
  for (const o of outcomes) {
    const current = tally[o.detectorId] ?? { ok: 0, insufficient: 0, error: 0, findings: 0 };
    tally[o.detectorId] = { ...current, [o.status]: current[o.status] + 1, findings: current.findings + o.findings.length };
  }
  return tally;
}

/** 근거 bin 표의 기준 기간 (bin별 기준이면 bin마다 다르다) */
function referenceRanges(evidence: unknown): { from: number; to: number }[] {
  const bins = evidence !== null && typeof evidence === 'object' && 'bins' in evidence && Array.isArray(evidence.bins) ? (evidence.bins as unknown[]) : [];
  return bins.flatMap((bin) => {
    const b = bin !== null && typeof bin === 'object' ? (bin as Record<string, unknown>) : {};
    return b.used === true && typeof b.ref_from === 'number' && typeof b.ref_to === 'number' ? [{ from: b.ref_from, to: b.ref_to }] : [];
  });
}

/** 용량 감소 finding이 난 랙은 대표 세션 충전 곡선을 읽어 같은 시드로 다시 탐지해 오버레이를 채운다 */
async function withCapacityCurves(ctx: SiteRunContext, snapshot: SiteSnapshot, points: readonly PointRow[], outcomes: readonly DetectorOutcome[], options: DetectOptions): Promise<DetectorOutcome[]> {
  const index = indexSnapshot(snapshot);
  const result: DetectorOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.detectorId !== essCapacityFade.id || outcome.assetId === null || outcome.findings.length === 0) {
      result.push(outcome);
      continue;
    }
    try {
      const sessions = index.episodesOf(outcome.assetId, 'ess.charge').filter((s) => s.valid && s.end <= options.now);
      const ranges = referenceRanges(outcome.findings[0]?.evidence);
      const referenceSessions = ranges.length === 0 ? sessions.slice(0, 60) : sessions.filter((s) => ranges.some((range) => s.start >= range.from && s.start <= range.to));
      const candidates = [...referenceSessions, ...sessions.filter((s) => s.start >= options.now - 45 * MS_PER_DAY)];
      const curves = await loadChargeCurves(ctx.db, outcome.assetId, points, [...new Map(candidates.map((s) => [s.start, { start: s.start, end: s.end }])).values()]);
      const rerun = runSiteDetectors({ ...snapshot, curves: new Map([[outcome.assetId, curves]]) }, { ...options, detectorIds: ['ess.capacity_fade'], targetAssetIds: new Set([outcome.assetId]) });
      result.push(rerun[0] ?? outcome);
    } catch (error) {
      recordError(ctx, { stage: 'curves', siteId: snapshot.siteId, assetId: outcome.assetId, detectorId: outcome.detectorId }, error);
      result.push(outcome);
    }
  }
  return result;
}

interface SiteData {
  readonly site: SiteRow;
  readonly assets: readonly PipelineAsset[];
  readonly targets: readonly PipelineAsset[];
  readonly points: readonly PointRow[];
}

/** 대상 설비 에피소드 추출·저장. 시간 예산을 넘은 설비는 건너뛴다 */
async function extractSite(ctx: SiteRunContext, data: SiteData): Promise<{ extractedAssets: number; episodesSaved: number; skipped: string[] }> {
  const skipped: string[] = [];
  let extractedAssets = 0;
  let episodesSaved = 0;
  for (const asset of data.targets.filter((a) => isExtractable(a.classKey))) {
    if (overBudget(ctx)) {
      skipped.push(`extract:${asset.code}`);
      continue;
    }
    try {
      episodesSaved += await extractAsset(ctx, asset, data.assets, data.points);
      extractedAssets += 1;
    } catch (error) {
      recordError(ctx, { stage: 'extract', siteId: data.site.id, assetId: asset.id }, error);
    }
  }
  return { extractedAssets, episodesSaved, skipped };
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

async function detect(ctx: SiteRunContext, data: SiteData, history: readonly StoredEpisode[]): Promise<DetectorOutcome[]> {
  const dq = await loadDqInput(ctx.db, data.site.id, data.points.filter((p) => ctx.assetIds === null || ctx.assetIds.has(p.assetId)), ctx.window).catch((error: unknown) => {
    recordError(ctx, { stage: 'dq', siteId: data.site.id }, error);
    return null;
  });
  const events = await loadAssetEvents(ctx.db, data.assets.map((a) => a.id), new Date(ctx.window.end));
  const snapshot: SiteSnapshot = { siteId: data.site.id, assets: data.assets, episodes: history, events, configs: ctx.configs, dq };
  const options: DetectOptions = { now: ctx.window.end, seed: ctx.seed, targetAssetIds: ctx.assetIds ?? undefined };
  const outcomes = await withCapacityCurves(ctx, snapshot, data.points, runSiteDetectors(snapshot, options), options);
  outcomes.filter((o) => o.status === 'error').forEach((o) => recordError(ctx, { stage: 'detect', siteId: data.site.id, assetId: o.assetId ?? undefined, detectorId: o.detectorId }, o.reason));
  return outcomes;
}

async function verifySite(ctx: SiteRunContext, site: SiteRow): Promise<SiteRunStats> {
  const started = ctx.now().getTime();
  const assets = await loadSiteAssets(ctx.db, site.id);
  const targets = assets.filter((a) => ctx.assetIds === null || ctx.assetIds.has(a.id));
  const history = await loadEpisodes(ctx.db, targets.filter((a) => isExtractable(a.classKey)).map((a) => a.id), ctx.window.end);
  const verification = await verifyActions(ctx.db, { runId: ctx.runId, siteId: site.id, assetIds: ctx.assetIds, until: ctx.window.end, episodes: history, seed: ctx.seed }).catch((error: unknown) => {
    recordError(ctx, { stage: 'verify', siteId: site.id }, error);
    return null;
  });
  return { siteId: site.id, siteCode: site.code, assets: targets.length, extractedAssets: 0, episodesSaved: 0, episodesInHistory: history.length, kpiRows: 0, detectors: {}, findings: EMPTY_PERSIST_STATS, verification, skipped: [], elapsedMs: ctx.now().getTime() - started };
}

export async function runSite(ctx: SiteRunContext, site: SiteRow): Promise<SiteRunStats> {
  if (ctx.verifyOnly) return verifySite(ctx, site);
  const started = ctx.now().getTime();
  const [assets, points] = await Promise.all([loadSiteAssets(ctx.db, site.id), loadSitePoints(ctx.db, site.id)]);
  const data: SiteData = { site, assets, points, targets: assets.filter((a) => ctx.assetIds === null || ctx.assetIds.has(a.id)) };
  const extraction = await extractSite(ctx, data);
  const base = { siteId: site.id, siteCode: site.code, assets: data.targets.length, extractedAssets: extraction.extractedAssets, episodesSaved: extraction.episodesSaved };
  if (overBudget(ctx)) {
    ctx.log(`${site.code}: 시간 예산 초과로 KPI·탐지·검증을 건너뜁니다`);
    return { ...base, episodesInHistory: 0, kpiRows: 0, detectors: {}, findings: EMPTY_PERSIST_STATS, verification: null, skipped: [...extraction.skipped, 'kpi', 'detect', 'verify'], elapsedMs: ctx.now().getTime() - started };
  }
  const history = await loadEpisodes(ctx.db, assets.filter((a) => isExtractable(a.classKey)).map((a) => a.id), ctx.window.end);
  const kpiRows = await computeKpis(ctx, data, history);
  const outcomes = await detect(ctx, data, history);
  const findings = await persistFindings(ctx.db, { runId: ctx.runId, siteId: site.id, outcomes, now: ctx.now() }).catch((error: unknown) => {
    recordError(ctx, { stage: 'findings', siteId: site.id }, error);
    return EMPTY_PERSIST_STATS;
  });
  const verification = await verifyActions(ctx.db, { runId: ctx.runId, siteId: site.id, assetIds: ctx.assetIds, until: ctx.window.end, episodes: history, seed: ctx.seed }).catch((error: unknown) => {
    recordError(ctx, { stage: 'verify', siteId: site.id }, error);
    return null;
  });
  return { ...base, episodesInHistory: history.length, kpiRows, detectors: tallyDetectors(outcomes), findings, verification, skipped: extraction.skipped, elapsedMs: ctx.now().getTime() - started };
}
