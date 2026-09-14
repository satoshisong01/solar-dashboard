// 수동 분석 실행 전 단계 (hysol_test): 에피소드 추출·저장 → 탐지 → finding dedup → 기각·억제 → 기준선 재설정 → 재발 → 조치 효과 검증 → 잠금·시간 예산.
// 테스트는 순서대로 한 finding의 수명을 따라간다.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisBusyError, runAnalysis, type AnalysisRequest } from '@/lib/analysis/run';
import { dismissFinding, registerMaintenanceAction, reopenFinding, TransitionError, triageFinding } from '@/lib/analysis/transitions';
import { ANALYSIS_BASE_MS, createAnalysisFixture, DAY_MS, dropAnalysisFixture, RATE_UV_PER_H, type AnalysisFixture } from '../support/analysis-fixture';
import { createTestDb } from '../support/ingest-fixture';
import { assertTestDatabaseUrl } from '../support/test-env';

const DAYS = 18;
const STEP_DAY = 12;
const ADMIN = 'admin@hysol.local';
const at = (day: number): Date => new Date(ANALYSIS_BASE_MS + day * DAY_MS);

describe('분석 실행 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: AnalysisFixture;
  let firstFindingId: string;
  let recurrenceId: string;
  const request = (to: number, extra: Partial<AnalysisRequest> = {}): AnalysisRequest => ({ siteIds: [fixture.siteId], from: at(0), to: at(to), requestedBy: ADMIN, ...extra });
  const findings = () => db.selectFrom('om.finding').selectAll().where('site_id', '=', fixture.siteId).orderBy('id').execute();

  beforeAll(async () => {
    fixture = await createAnalysisFixture(db, DAYS, STEP_DAY);
  }, 120_000);

  afterAll(async () => {
    await dropAnalysisFixture(db);
    await db.destroy();
  });

  it('1차 실행: 롤업 → 에피소드 저장 → 전해조 전압 상승 finding 생성 (근거·전이·실행 통계)', async () => {
    const result = await runAnalysis(db, request(STEP_DAY), { now: () => at(STEP_DAY) });
    expect(result.status).toBe('succeeded');
    const [site] = result.stats.sites;
    expect(result.stats.rollup.picked).toBeGreaterThan(0);
    expect(site).toMatchObject({ assets: 2, extractedAssets: 1, findings: { created: 1, updated: 0 } });
    expect(site?.detectors['el.voltage_rise']).toMatchObject({ ok: 1, findings: 1 });
    expect(site?.detectors['dq.gap_flatline']).toMatchObject({ ok: 1, findings: 0 });

    const episodes = await db.selectFrom('om.episode').select(['kind', 'valid', 'run_id']).where('asset_id', '=', fixture.stackId).execute();
    expect(episodes.filter((e) => e.kind === 'el.steady_run')).toHaveLength(2 * STEP_DAY);
    expect(episodes.every((e) => e.run_id === result.runId)).toBe(true);

    const [finding] = await findings();
    expect(finding).toMatchObject({ detector_id: 'el.voltage_rise', status: 'new', severity: 3, detection_count: 1, dedup_key: `el.voltage_rise|${fixture.stackId}|el.stack_voltage_degradation`, asset_id: fixture.stackId });
    expect((finding?.effect as { value: number }).value).toBeCloseTo(RATE_UV_PER_H, 0);
    const evidence = await db.selectFrom('om.finding_evidence').select(['id', 'input_hash', 'snapshot']).where('finding_id', '=', finding?.id ?? '0').execute();
    expect(evidence).toHaveLength(1);
    expect(finding?.latest_evidence_id).toBe(evidence[0]?.id);
    expect(evidence[0]?.snapshot).toMatchObject({ detector: 'el.voltage_rise@1', method: 'binned_residual_theil_sen' });
    const run = await db.selectFrom('om.analysis_run').select(['status', 'finished_at', 'stats']).where('id', '=', result.runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    expect(run.finished_at).not.toBeNull();
    firstFindingId = finding?.id ?? '';
  }, 120_000);

  it('같은 요청을 다시 실행하면 finding은 하나, detection_count 2, 근거 2건, 에피소드는 교체', async () => {
    await triageFinding(db, { findingId: firstFindingId, actor: ADMIN });
    const result = await runAnalysis(db, request(STEP_DAY), { now: () => at(STEP_DAY + 0.1) });
    expect(result.stats.sites[0]?.findings).toMatchObject({ created: 0, updated: 1 });
    const all = await findings();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: firstFindingId, detection_count: 2, status: 'triaged' });
    expect(await db.selectFrom('om.finding_evidence').select('id').where('finding_id', '=', firstFindingId).execute()).toHaveLength(2);
    expect(await db.selectFrom('om.episode').select('kind').where('asset_id', '=', fixture.stackId).where('kind', '=', 'el.steady_run').execute()).toHaveLength(2 * STEP_DAY);
  }, 120_000);

  it("기각 사유 '운영 조건 변경' + 기준선 분할 → 같은 탐지가 insufficient가 되어 새 finding이 생기지 않는다", async () => {
    await expect(dismissFinding(db, { findingId: firstFindingId, actor: ADMIN, reason: '  ' })).rejects.toThrow(TransitionError);
    await expect(dismissFinding(db, { findingId: firstFindingId, actor: ADMIN, reason: '센서 이상', resetBaseline: { ts: at(11) } })).rejects.toThrow('운영 조건 변경');
    const dismissed = await dismissFinding(db, { findingId: firstFindingId, actor: ADMIN, reason: '운영 조건 변경', suppressDays: 0, resetBaseline: { ts: at(11) } });
    expect(dismissed).toMatchObject({ from: 'triaged', to: 'dismissed' });
    const event = await db.selectFrom('om.asset_event').selectAll().where('id', '=', dismissed.assetEventId ?? '0').executeTakeFirstOrThrow();
    expect(event).toMatchObject({ asset_id: fixture.stackId, resets_baseline: true, kind: 'setpoint_change', created_by: ADMIN });

    const result = await runAnalysis(db, request(STEP_DAY), { now: () => at(STEP_DAY + 0.2) });
    expect(result.stats.sites[0]?.detectors['el.voltage_rise']).toMatchObject({ insufficient: 1, findings: 0 });
    expect(result.stats.sites[0]?.findings.created).toBe(0);
    expect((await findings()).map((f) => f.status)).toEqual(['dismissed']);
  }, 120_000);

  it('기준선 분할을 지우면 다시 탐지해 재발 finding(previous_finding_id), 억제 기간 안 기각이면 새 finding을 만들지 않는다', async () => {
    await db.deleteFrom('om.asset_event').where('asset_id', '=', fixture.stackId).execute();
    const recurrence = await runAnalysis(db, request(STEP_DAY), { now: () => at(STEP_DAY + 0.3) });
    expect(recurrence.stats.sites[0]?.findings).toMatchObject({ created: 1, recurrences: 1 });
    const [, second] = await findings();
    expect(second).toMatchObject({ status: 'new', previous_finding_id: firstFindingId, detection_count: 1 });
    recurrenceId = second?.id ?? '';

    await dismissFinding(db, { findingId: recurrenceId, actor: ADMIN, reason: '현장 확인 결과 정상', suppressDays: 30, now: at(STEP_DAY + 0.3) });
    const suppressed = await runAnalysis(db, request(STEP_DAY), { now: () => at(STEP_DAY + 0.4) });
    expect(suppressed.stats.sites[0]?.findings).toMatchObject({ created: 0, suppressed: 1 });
    expect((await findings()).map((f) => f.status)).toEqual(['dismissed', 'dismissed']);
    await expect(reopenFinding(db, { findingId: firstFindingId, actor: 'system' })).rejects.toThrow('관리자');
  }, 120_000);

  it('조치 기록 → action_taken, 후 창이 채워진 뒤 분석하면 전후 비교 improved → system이 verified로 전이', async () => {
    await reopenFinding(db, { findingId: recurrenceId, actor: ADMIN, note: '조치 대상' });
    await expect(reopenFinding(db, { findingId: firstFindingId, actor: ADMIN })).rejects.toThrow('열린 발견사항');
    const effect = { metric: 'el.v_cell_v', direction: 'decrease' as const, min_delta: 0.005, stabilization_days: 1, window_days: 4 };
    const action = await registerMaintenanceAction(db, { siteId: fixture.siteId, assetId: fixture.stackId, findingId: recurrenceId, actionType: '스택 재체결', performedAt: at(STEP_DAY), expectedEffect: effect, source: 'manual', actor: ADMIN });
    expect(action.transition).toMatchObject({ from: 'reopened', to: 'action_taken' });

    const pending = await runAnalysis(db, request(STEP_DAY + 3), { now: () => at(STEP_DAY + 3) });
    expect(pending.stats.sites[0]?.verification).toMatchObject({ checked: 0, pending: 1 });

    const result = await runAnalysis(db, request(DAYS), { now: () => at(DAYS) });
    expect(result.status).toBe('succeeded');
    expect(result.stats.sites[0]?.verification).toMatchObject({ checked: 1, verdicts: { improved: 1 }, verifiedFindings: 1 });
    const verification = await db.selectFrom('om.action_verification').selectAll().where('action_id', '=', action.actionId).executeTakeFirstOrThrow();
    expect(verification).toMatchObject({ method: 'matched_before_after@1', verdict: 'improved', run_id: result.runId });
    expect(verification.effect).toBeCloseTo(-0.0085, 3);
    expect(verification.ci_high).toBeLessThan(0);
    const finding = await db.selectFrom('om.finding').select('status').where('id', '=', recurrenceId).executeTakeFirstOrThrow();
    expect(finding.status).toBe('verified');
    const last = await db.selectFrom('om.finding_transition').select(['to_status', 'actor']).where('finding_id', '=', recurrenceId).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(last).toEqual({ to_status: 'verified', actor: 'system' });
  }, 180_000);

  it('같은 사이트 잠금이 잡혀 있으면 실행 행을 failed로 남기고 거절, 잠금이 풀리면 중단된 running 행을 정리한다', async () => {
    const holder = new pg.Client({ connectionString: assertTestDatabaseUrl(process.env.DATABASE_URL) });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('om.analysis_run'), $1::int4)", [fixture.siteId]);
      const busy = runAnalysis(db, request(1), { now: () => at(DAYS) });
      await expect(busy).rejects.toThrow(AnalysisBusyError);
      const failed = await db.selectFrom('om.analysis_run').select(['status', 'error']).orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('이미 진행 중');
    } finally {
      await holder.end();
    }
    const stale = await db.insertInto('om.analysis_run').values({ requested_by: ADMIN, scope: JSON.stringify({ siteIds: [fixture.siteId], from: at(0).toISOString(), to: at(1).toISOString() }), started_at: at(DAYS) }).returning('id').executeTakeFirstOrThrow();
    const result = await runAnalysis(db, request(1), { now: () => at(DAYS + 0.5), timeBudgetMs: -1 });
    expect(result.status).toBe('partial');
    expect(result.stats).toMatchObject({ abandonedRunsFailed: 1, budgetExceeded: true });
    expect(result.stats.sites[0]?.skipped).toContain('detect');
    const cleaned = await db.selectFrom('om.analysis_run').select(['status', 'error']).where('id', '=', stale.id).executeTakeFirstOrThrow();
    expect(cleaned.status).toBe('failed');
  }, 120_000);
});
