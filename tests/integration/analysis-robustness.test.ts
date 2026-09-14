// 분석 실행기의 견고성 (hysol_test): 재실행 멱등 · 같은 사이트 동시 실행 잠금 · 단계 오류(partial)와 실행 실패(failed).
// 단계 오류는 전해조 전압 상승 탐지기에 예외를 주입해 만든다 (vi.mock은 이 파일에만 적용된다).
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Detector } from '@/lib/analytics/detectors/types';
import { AnalysisBusyError, runAnalysis, type AnalysisRequest, type AnalysisRunResult } from '@/lib/analysis/run';
import type { DB } from '@/lib/db/types';
import { ANALYSIS_BASE_MS, createAnalysisFixture, DAY_MS, dropAnalysisFixture, type AnalysisFixture } from '../support/analysis-fixture';
import { createTestDb } from '../support/ingest-fixture';
import { assertTestDatabaseUrl } from '../support/test-env';

const injected = vi.hoisted(() => ({ failDetector: null as string | null }));

vi.mock('@/lib/analytics/detectors/stack-detectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/detectors/stack-detectors')>();
  const failing = <I, P>(detector: Detector<I, P>): Detector<I, P> => ({
    ...detector,
    detect: (input, ctx) => {
      if (injected.failDetector === detector.id) throw new Error('테스트가 주입한 탐지기 오류');
      return detector.detect(input, ctx);
    },
  });
  return { ...actual, elVoltageRise: failing(actual.elVoltageRise), fcVoltageDecay: failing(actual.fcVoltageDecay) };
});

const DAYS = 18;
const STEP_DAY = 12;
const ADMIN = 'admin@hysol.local';
const at = (day: number): Date => new Date(ANALYSIS_BASE_MS + day * DAY_MS);

interface EpisodeRow {
  readonly asset_id: number;
  readonly kind: string;
  readonly start_ts: Date;
  readonly end_ts: Date;
  readonly valid: boolean;
  readonly invalid_reason: string | null;
}

interface PipelineSnapshot {
  readonly episodes: readonly EpisodeRow[];
  readonly kpis: readonly unknown[];
  readonly findings: readonly { readonly id: string; readonly dedup_key: string; readonly status: string; readonly severity: number; readonly effect: unknown; readonly detection_count: number }[];
  readonly latestInputHash: string | null;
  readonly evidenceRows: number;
}

async function snapshotOf(db: Kysely<DB>, fixture: AnalysisFixture): Promise<PipelineSnapshot> {
  const episodes = await db
    .selectFrom('om.episode')
    .select(['asset_id', 'kind', 'start_ts', 'end_ts', 'extractor_version', 'features', 'conditions', 'dq', 'valid', 'invalid_reason'])
    .where('asset_id', 'in', [fixture.elzId, fixture.stackId])
    .orderBy('asset_id')
    .orderBy('kind')
    .orderBy('start_ts')
    .execute();
  const kpis = await db
    .selectFrom('om.kpi_daily')
    .select(['scope_type', 'scope_id', sql<string>`day::text`.as('day'), 'kpi_key', 'value', 'unit', 'n', 'dq_completeness'])
    .where((eb) => eb.or([eb.and([eb('scope_type', '=', 'site'), eb('scope_id', '=', fixture.siteId)]), eb.and([eb('scope_type', '=', 'asset'), eb('scope_id', 'in', [fixture.elzId, fixture.stackId])])]))
    .orderBy('scope_type')
    .orderBy('scope_id')
    .orderBy('day')
    .orderBy('kpi_key')
    .execute();
  const findings = await db.selectFrom('om.finding').select(['id', 'dedup_key', 'status', 'severity', 'effect', 'detection_count']).where('site_id', '=', fixture.siteId).orderBy('id').execute();
  const evidence = await db.selectFrom('om.finding_evidence').select(['input_hash']).where('finding_id', 'in', findings.length > 0 ? findings.map((f) => f.id) : ['0']).orderBy('id', 'desc').execute();
  return { episodes, kpis, findings, latestInputHash: evidence[0]?.input_hash ?? null, evidenceRows: evidence.length };
}

const runRow = (db: Kysely<DB>, runId: string) => db.selectFrom('om.analysis_run').select(['status', 'error', 'stats', 'finished_at']).where('id', '=', runId).executeTakeFirstOrThrow();

/** 다른 연결에서 이 사이트의 분석 잠금(pg_try_advisory_xact_lock 두 키)이 잡힐 때까지 기다린다 */
async function waitForSiteLock(client: pg.Client, siteId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND objid = $1::oid", [siteId]);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`사이트 ${siteId} 분석 잠금이 ${timeoutMs} ms 안에 잡히지 않았습니다`);
}

describe('분석 실행기 견고성 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: AnalysisFixture;
  let baseline: PipelineSnapshot;
  const request = (extra: Partial<AnalysisRequest> = {}): AnalysisRequest => ({ siteIds: [fixture.siteId], from: at(0), to: at(STEP_DAY), requestedBy: ADMIN, ...extra });

  beforeAll(async () => {
    fixture = await createAnalysisFixture(db, DAYS, STEP_DAY);
  }, 120_000);

  afterAll(async () => {
    injected.failDetector = null;
    await dropAnalysisFixture(db);
    await db.destroy();
  });

  it('재실행 멱등: 같은 요청을 다시 실행해도 에피소드·KPI·finding 수와 내용이 같고, 탐지 횟수와 근거만 한 번씩 늘어난다', async () => {
    const first = await runAnalysis(db, request(), { now: () => at(STEP_DAY) });
    expect(first.status).toBe('succeeded');
    baseline = await snapshotOf(db, fixture);
    expect(baseline.episodes.length).toBeGreaterThan(0);
    expect(baseline.kpis.length).toBeGreaterThan(0);
    expect(baseline.findings).toHaveLength(1);

    for (const round of [2, 3]) {
      const again = await runAnalysis(db, request(), { now: () => at(STEP_DAY + round * 0.01) });
      expect(again.status).toBe('succeeded');
      expect(again.stats.sites[0]?.findings).toMatchObject({ created: 0, updated: 1 });
      const snapshot = await snapshotOf(db, fixture);
      expect(snapshot.episodes).toEqual(baseline.episodes);
      expect(snapshot.kpis).toEqual(baseline.kpis);
      const identity = (f: PipelineSnapshot['findings'][number]) => [f.id, f.dedup_key, f.status, f.severity, f.effect];
      expect(snapshot.findings.map(identity)).toEqual(baseline.findings.map(identity));
      expect(snapshot.findings[0]?.detection_count).toBe(round);
      expect(snapshot.evidenceRows).toBe(round);
      expect(snapshot.latestInputHash).toBe(baseline.latestInputHash);
    }
  }, 180_000);

  it('겹침 재처리: 끝 3일만 다시 분석해도 에피소드 수·구간·정상운전 특징, KPI는 같고 finding은 중복되지 않는다', async () => {
    const tail = await runAnalysis(db, request({ from: at(STEP_DAY - 3) }), { now: () => at(STEP_DAY + 0.05) });
    expect(tail.status).toBe('succeeded');
    expect(tail.stats.sites[0]?.episodesSaved).toBeGreaterThan(0);
    const snapshot = await snapshotOf(db, fixture);
    const outline = (e: EpisodeRow) => [e.asset_id, e.kind, e.start_ts, e.end_ts, e.valid, e.invalid_reason];
    expect(snapshot.episodes.map(outline)).toEqual(baseline.episodes.map(outline));
    // 기동(start) 에피소드의 정지 시간·냉간 여부는 비교하지 않는다: 직전 정지가 재추출 창 시작 − 2시간보다 앞이면 원시를 읽지 않아 null이 된다
    // (전체 창 재실행의 내용 멱등은 위 테스트가 확인한다)
    const steady = (episodes: readonly EpisodeRow[]) => episodes.filter((e) => !e.kind.endsWith('.start'));
    expect(steady(snapshot.episodes)).toEqual(steady(baseline.episodes));
    expect(snapshot.kpis).toEqual(baseline.kpis);
    expect(snapshot.findings.map((f) => [f.id, f.dedup_key, f.status])).toEqual(baseline.findings.map((f) => [f.id, f.dedup_key, f.status]));
  }, 120_000);

  it('동시 실행 잠금: 앞 실행이 잠금을 잡고 있는 동안 들어온 같은 사이트 요청은 실행 행을 failed로 남기고 AnalysisBusyError', async () => {
    // 앞 실행이 끝나 버리지 않도록 finding 행을 다른 연결에서 잠가 둔다: 앞 실행은 분석 잠금을 잡은 채 finding 갱신에서 기다린다
    const blocker = new pg.Client({ connectionString: assertTestDatabaseUrl(process.env.DATABASE_URL) });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM om.finding WHERE site_id = $1 FOR UPDATE', [fixture.siteId]);
      const running = runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.06) });
      await waitForSiteLock(blocker, fixture.siteId);
      const busy = await runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.07) }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(busy).toBeInstanceOf(AnalysisBusyError);
      const busyRun = await runRow(db, (busy as AnalysisBusyError).runId);
      expect(busyRun).toMatchObject({ status: 'failed', error: expect.stringContaining('이미 진행 중') });
      expect(busyRun.finished_at).not.toBeNull();

      await blocker.query('ROLLBACK');
      const done = await running;
      expect(done.status).toBe('succeeded');
      expect(done.stats.abandonedRunsFailed).toBe(0);
      expect(done.stats.sites[0]?.findings).toMatchObject({ created: 0, updated: 1 });
    } finally {
      await blocker.end();
    }
    const snapshot = await snapshotOf(db, fixture);
    expect(snapshot.episodes).toEqual(baseline.episodes);
    expect(snapshot.findings).toHaveLength(1);
  }, 120_000);

  it('동시 실행 잠금: 같은 사이트 두 요청을 동시에 보내면 정확히 하나만 실행되고 결과는 중복되지 않는다', async () => {
    const settled = await Promise.allSettled([runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.08) }), runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.08) })]);
    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<AnalysisRunResult> => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]?.value.status).toBe('succeeded');
    expect(rejected[0]?.reason).toBeInstanceOf(AnalysisBusyError);
    expect((await runRow(db, (rejected[0]?.reason as AnalysisBusyError).runId)).status).toBe('failed');
    const snapshot = await snapshotOf(db, fixture);
    expect(snapshot.episodes).toEqual(baseline.episodes);
    expect(snapshot.findings).toHaveLength(1);
  }, 120_000);

  it('단계 오류: 탐지기 하나가 예외를 내면 오류를 기록하고 나머지 단계는 계속해 partial, finding은 그대로 두고 다음 실행은 정상', async () => {
    const before = await snapshotOf(db, fixture);
    injected.failDetector = 'el.voltage_rise';
    let partial: AnalysisRunResult;
    try {
      partial = await runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.1) });
    } finally {
      injected.failDetector = null;
    }
    expect(partial.status).toBe('partial');
    expect(partial.stats.errors).toEqual([{ stage: 'detect', siteId: fixture.siteId, assetId: fixture.stackId, detectorId: 'el.voltage_rise', message: '테스트가 주입한 탐지기 오류' }]);
    const [site] = partial.stats.sites;
    expect(site?.detectors['el.voltage_rise']).toMatchObject({ ok: 0, error: 1, findings: 0 });
    expect(site?.detectors['dq.gap_flatline']).toMatchObject({ ok: 1, error: 0 });
    expect(site).toMatchObject({ extractedAssets: 1, findings: { created: 0, updated: 0 } });
    expect(site?.episodesSaved).toBeGreaterThan(0);
    expect(site?.kpiRows).toBeGreaterThan(0);

    const row = await runRow(db, partial.runId);
    expect(row).toMatchObject({ status: 'partial', error: null, stats: { errors: [{ stage: 'detect', detectorId: 'el.voltage_rise' }] } });
    const after = await snapshotOf(db, fixture);
    expect(after.findings).toEqual(before.findings);
    expect(after.episodes).toEqual(baseline.episodes);

    const recovered = await runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.2) });
    expect(recovered).toMatchObject({ status: 'succeeded', stats: { errors: [] } });
    expect(recovered.stats.sites[0]?.findings).toMatchObject({ created: 0, updated: 1 });
  }, 180_000);

  it('실행 실패: 없는 사이트가 섞이면 아무 단계도 하지 않고 failed로 끝나며 잠금이 풀려 다음 실행이 가능하다', async () => {
    const before = await snapshotOf(db, fixture);
    const failed = await runAnalysis(db, request({ siteIds: [fixture.siteId, 32_000] }), { now: () => at(STEP_DAY + 0.3) });
    expect(failed.status).toBe('failed');
    expect(failed.stats.errors[0]).toMatchObject({ stage: 'run', message: expect.stringContaining('없는 사이트가 있습니다: 32000') });
    expect(await runRow(db, failed.runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('없는 사이트') });
    const after = await snapshotOf(db, fixture);
    expect(after.findings).toEqual(before.findings);
    expect(after.evidenceRows).toBe(before.evidenceRows);

    const next = await runAnalysis(db, request(), { now: () => at(STEP_DAY + 0.4) });
    expect(next.status).toBe('succeeded');
  }, 120_000);
});
