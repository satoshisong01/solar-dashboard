// 사이트 탐지 단계 (DB): 입력 조회 → 탐지기 13종(물질수지 제외) → 용량 오버레이 → 체인 원장 계산·저장 → 물질수지 탐지.
// 물질수지는 같은 실행에서 저장한 원장과 저장용기 누설 결과를 쓰므로 원장 뒤에 따로 실행한다.
import type { Kysely } from 'kysely';
import { essCapacityFade } from '@/lib/analytics/detectors/ess-capacity-fade';
import { PIPELINE_DETECTOR_IDS, runSiteDetectors, type DetectOptions } from '@/lib/analytics/pipeline/detect';
import { indexSnapshot, type SiteSnapshot } from '@/lib/analytics/pipeline/snapshot';
import type { DetectorConfigRow, DetectorOutcome, PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import { kstDayStart, MS_PER_DAY, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import { loadAuxInputs } from './aux-inputs';
import { loadAssetEvents, type PointRow, type SiteRow } from './catalog';
import { loadDqInput } from './dq-summary';
import { computeSiteLedger, loadLedgerDays, type LedgerStats } from './ledger';
import { loadChargeCurves } from './series';
import { loadTankHoldInputs } from './tank-holds';

const MASS_BALANCE = 'h2chain.mass_balance_gap';

export interface DetectStageContext {
  readonly db: Kysely<DB>;
  readonly runId: string;
  readonly window: TimeWindow;
  readonly assetIds: ReadonlySet<number> | null;
  readonly overlapMs: number;
  readonly seed: number;
  readonly configs: readonly DetectorConfigRow[];
  readonly now: () => Date;
  readonly onError: (stage: 'dq' | 'curves' | 'ledger', error: unknown, detail?: { assetId?: number; detectorId?: string }) => void;
  /** 단계별 소요시간 [ms]를 더한다 */
  readonly time: <T>(stage: 'aux' | 'detect' | 'ledger', work: () => Promise<T>) => Promise<T>;
}

export interface DetectStageData {
  readonly site: SiteRow;
  readonly assets: readonly PipelineAsset[];
  readonly points: readonly PointRow[];
  readonly history: readonly StoredEpisode[];
}

export interface DetectStageResult {
  readonly outcomes: readonly DetectorOutcome[];
  readonly ledger: LedgerStats | null;
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
async function withCapacityCurves(ctx: DetectStageContext, snapshot: SiteSnapshot, points: readonly PointRow[], outcomes: readonly DetectorOutcome[], options: DetectOptions): Promise<DetectorOutcome[]> {
  const index = indexSnapshot(snapshot);
  const result: DetectorOutcome[] = []; // 결과를 순서대로 모으는 누적 목록 (이 함수 안에서만 채운다)
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
      ctx.onError('curves', error, { assetId: outcome.assetId, detectorId: outcome.detectorId });
      result.push(outcome);
    }
  }
  return result;
}

async function snapshotOf(ctx: DetectStageContext, data: DetectStageData): Promise<SiteSnapshot> {
  const targetPoints = data.points.filter((p) => ctx.assetIds === null || ctx.assetIds.has(p.assetId));
  const dq = await loadDqInput(ctx.db, data.site.id, targetPoints, ctx.window).catch((error: unknown) => {
    ctx.onError('dq', error);
    return null;
  });
  const events = await loadAssetEvents(ctx.db, data.assets.map((a) => a.id), new Date(ctx.window.end));
  const base: SiteSnapshot = { siteId: data.site.id, assets: data.assets, episodes: data.history, events, configs: ctx.configs, dq };
  return ctx.time('aux', async () => {
    const aux = await loadAuxInputs(ctx.db, data.site.id, data.assets, data.points, ctx.configs, ctx.window.end);
    const tank = await loadTankHoldInputs(ctx.db, indexSnapshot(base), data.points, ctx.window.end, ctx.assetIds);
    return { ...base, aux: { ...aux, tankHoldPoints: tank.points, tankCrossChecks: tank.crossChecks } };
  });
}

export async function detectSite(ctx: DetectStageContext, data: DetectStageData): Promise<DetectStageResult> {
  const snapshot = await snapshotOf(ctx, data);
  const options: DetectOptions = { now: ctx.window.end, seed: ctx.seed, targetAssetIds: ctx.assetIds ?? undefined };
  const first = await ctx.time('detect', () => withCapacityCurves(ctx, snapshot, data.points, runSiteDetectors(snapshot, { ...options, detectorIds: PIPELINE_DETECTOR_IDS.filter((id) => id !== MASS_BALANCE) }), options));
  const ledger = await ctx
    .time('ledger', () => computeSiteLedger(ctx.db, { siteId: data.site.id, runId: ctx.runId, assets: data.assets, points: data.points, window: { start: kstDayStart(ctx.window.start - ctx.overlapMs), end: ctx.window.end }, outcomes: first, computedAt: ctx.now() }))
    .catch((error: unknown) => {
      ctx.onError('ledger', error);
      return null;
    });
  const ledgerDays = await loadLedgerDays(ctx.db, data.site.id, ctx.window.end);
  const second = await ctx.time('detect', async () => runSiteDetectors({ ...snapshot, aux: { ...snapshot.aux, ledgerDays } }, { ...options, detectorIds: [MASS_BALANCE], priorOutcomes: first }));
  return { outcomes: [...first, ...second], ledger };
}
