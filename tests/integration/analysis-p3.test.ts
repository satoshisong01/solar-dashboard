// P3 분석 실행 (hysol_test): 체인 원장 site_energy_daily 멱등 · 사이트 단위 finding dedup · 설정 검증 실패(invalid_config) ·
// 저장용기 정지 구간 원시 부분 로드 · 조치 효과 검증 신규 지표(압축기 비에너지).
// 픽스처: 시드된 SIM-B의 수소 체인 포인트 21일(10일째부터 저장용기 2 누설 2 kg/일, tests/support/p3-fixture.ts).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSiteAssets, loadSitePoints } from '@/lib/analysis/catalog';
import { runAnalysis, type AnalysisRequest } from '@/lib/analysis/run';
import { loadAssetSeries } from '@/lib/analysis/series';
import { extractTankHoldsWindowed, loadTankHoldPoints } from '@/lib/analysis/tank-holds';
import { loadEpisodes } from '@/lib/analysis/episodes';
import { registerMaintenanceAction } from '@/lib/analysis/transitions';
import { TANK_STATIC_LEAK_DEFAULTS } from '@/lib/analytics/detectors/tank-static-leak';
import { tankHoldPoints } from '@/lib/analytics/episodes/tank-hold';
import { extractAssetEpisodes } from '@/lib/analytics/pipeline/extract';
import { indexSnapshot } from '@/lib/analytics/pipeline/snapshot';
import { seriesRequests } from '@/lib/analytics/pipeline/sources';
import { createP3Fixture, dropP3Fixture, P3_DAYS, P3_LEAK_TANK, p3At, p3Window, type P3Fixture } from '../support/p3-fixture';
import { createTestDb } from '../support/ingest-fixture';
import { assertTestDatabaseUrl } from '../support/test-env';

const ADMIN = 'admin@hysol.local';
const CHAIN = ['ELZ1', 'ELZ1/STACK1', 'ELZ1/RECT1', 'COMP1', 'H2BANK1', 'H2BANK1/TANK1', 'H2BANK1/TANK2', 'H2BANK1/TANK3', 'H2BANK1/TANK4', 'FC1', 'FC1/STACK1', 'FC1/BLOWER1', 'WX1'];

describe('P3 분석 실행 (hysol_test)', () => {
  const databaseUrl = assertTestDatabaseUrl(process.env.DATABASE_URL);
  const db = createTestDb();
  let fixture: P3Fixture;
  const request = (extra: Partial<AnalysisRequest> = {}): AnalysisRequest => ({ siteIds: [fixture.siteId], assetIds: CHAIN.map((code) => fixture.assetIdOf(code)), from: p3At(0), to: p3At(P3_DAYS), requestedBy: ADMIN, ...extra });
  const ledgerRows = () => db.selectFrom('om.site_energy_daily').select(['day', 'flows_kwh', 'energy_kwh', 'h2_kg', 'dq', 'elz_sec_kwh_per_kg', 'run_id']).where('site_id', '=', fixture.siteId).orderBy('day').execute();

  beforeAll(async () => {
    fixture = await createP3Fixture(db, databaseUrl);
  }, 240_000);

  afterAll(async () => {
    await dropP3Fixture(db);
    await db.destroy();
  });

  it('1차 실행: 원장 21일 저장, 누설 용기 finding과 사이트 단위 물질수지 finding(asset_id NULL, dedup site), 근거에 적용 설정', async () => {
    const result = await runAnalysis(db, request(), { now: () => p3At(P3_DAYS) });
    expect(result.status).toBe('succeeded');
    const [site] = result.stats.sites;
    expect(site?.ledger).toMatchObject({ days: P3_DAYS });
    expect(site?.stages.ledger).toBeGreaterThanOrEqual(0);
    expect(site?.detectors['tank.static_leak']?.ok).toBe(4);
    expect(site?.detectors['h2chain.mass_balance_gap']).toMatchObject({ ok: 1, findings: 1 });

    const rows = await ledgerRows();
    expect(rows).toHaveLength(P3_DAYS);
    expect(rows.every((r) => r.run_id === result.runId)).toBe(true);
    const residual = (row: (typeof rows)[number]) => (row.h2_kg as { residual_pct: number | null }).residual_pct ?? 0;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
    // 누설 전(0~9일) |잔차율| 중앙값은 1% 안, 누설 뒤(12일~)는 누설량(2 kg/일 ≈ 생산의 4~5%)만큼 양의 잔차
    expect(rows.every((r) => (r.h2_kg as { method: { produced: string } }).method.produced === 'meter_total')).toBe(true);
    expect(median(rows.slice(0, 10).map((r) => Math.abs(residual(r))))).toBeLessThan(1);
    expect(median(rows.slice(12).map(residual))).toBeGreaterThan(2.5);

    const findings = await db.selectFrom('om.finding').selectAll().where('site_id', '=', fixture.siteId).execute();
    const leak = findings.find((f) => f.detector_id === 'tank.static_leak');
    expect(leak).toMatchObject({ asset_id: fixture.assetIdOf(P3_LEAK_TANK), failure_mode: 'h2.storage_leak' });
    const chain = findings.filter((f) => f.detector_id === 'h2chain.mass_balance_gap');
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ asset_id: null, dedup_key: `h2chain.mass_balance_gap|site:${fixture.siteId}|h2chain.mass_balance_gap`, detection_count: 1 });
    const evidence = await db.selectFrom('om.finding_evidence').select('snapshot').where('finding_id', '=', chain[0]?.id ?? '0').executeTakeFirstOrThrow();
    expect(evidence.snapshot).toMatchObject({ detector: 'h2chain.mass_balance_gap@1', config: { scope: 'code_default', version: null } });
    expect((evidence.snapshot as { config: { params_hash: string } }).config.params_hash).toMatch(/^[0-9a-f]{16}$/);
    const checks = (evidence.snapshot as { checks: { id: string; status: string }[] }).checks;
    expect(checks.find((c) => c.id === 'storage_leak')?.status).toBe('supports');
  }, 240_000);

  it('같은 요청을 다시 실행하면 원장 값은 같고(run_id만 새 실행) 사이트 단위 finding은 하나로 갱신된다', async () => {
    const first = await ledgerRows();
    const result = await runAnalysis(db, request(), { now: () => p3At(P3_DAYS + 0.1) });
    const second = await ledgerRows();
    const withoutRun = (rows: typeof first) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'run_id')));
    expect(withoutRun(second)).toEqual(withoutRun(first));
    expect(second.every((r) => r.run_id === result.runId)).toBe(true);
    const chain = await db.selectFrom('om.finding').select(['id', 'detection_count', 'status']).where('site_id', '=', fixture.siteId).where('detector_id', '=', 'h2chain.mass_balance_gap').execute();
    expect(chain).toEqual([expect.objectContaining({ detection_count: 2, status: 'new' })]);
    expect(result.stats.sites[0]?.findings.created).toBe(0);
  }, 240_000);

  it('설정 검증 실패(범위 밖 값)는 그 탐지기만 invalid_config 판정 불능으로 남기고 실행 통계에 적는다', async () => {
    await db.insertInto('om.detector_config').values({ detector_id: 'comp.sec_rise', scope: 'default', version: 1, params: JSON.stringify({ sev2Pct: -1, unknownKey: 3 }), active: true, created_by: 'it-p3' }).execute();
    try {
      const result = await runAnalysis(db, request(), { now: () => p3At(P3_DAYS + 0.2) });
      const [site] = result.stats.sites;
      expect(site?.detectors['comp.sec_rise']).toMatchObject({ ok: 0, insufficient: 1, invalidConfig: 1, findings: 0 });
      expect(site?.configIssues).toEqual([expect.objectContaining({ detectorId: 'comp.sec_rise', assetId: fixture.assetIdOf('COMP1') })]);
      expect(site?.configIssues[0]?.reason).toMatch(/^invalid_config: sev2Pct/);
      expect(site?.detectors['tank.static_leak']?.invalidConfig).toBe(0);
      expect(result.status).toBe('succeeded');
    } finally {
      await db.deleteFrom('om.detector_config').where('created_by', '=', 'it-p3').execute();
    }
  }, 240_000);

  it('정지 구간: 롤업 후보 창만 원시를 읽어도 전체 원시 추출과 같은 tank.hold, 탐지 입력은 선택한 기준·최근 구간 원시만', async () => {
    const [assets, points] = await Promise.all([loadSiteAssets(db, fixture.siteId), loadSitePoints(db, fixture.siteId)]);
    const tank = assets.find((a) => a.code === 'H2BANK1/TANK1');
    if (!tank) throw new Error('TANK1 없음');
    const windowed = await extractTankHoldsWindowed(db, tank, assets, points, p3Window);
    const fullSeries = await loadAssetSeries(db, seriesRequests(tank, assets), points, p3Window);
    const full = extractAssetEpisodes(tank, fullSeries, p3Window);
    // 데이터 시작·끝에 걸린 구간은 전체 추출에서만 open이 되므로 안쪽 구간끼리 비교한다
    const interior = <E extends { start: number; end: number }>(items: readonly E[]) => items.filter((e) => e.start - p3Window.start > 3 * 3_600_000 && p3Window.end - e.end > 3 * 3_600_000);
    expect(interior(windowed.episodes).length).toBeGreaterThanOrEqual(TANK_STATIC_LEAK_DEFAULTS.referenceHolds);
    expect(interior(windowed.episodes)).toEqual(interior(full));
    expect(windowed.rawHours).toBeLessThan((P3_DAYS * 24) * 0.95);

    const history = await loadEpisodes(db, assets.map((a) => a.id), p3At(P3_DAYS).getTime());
    const index = indexSnapshot({ siteId: fixture.siteId, assets, episodes: history, events: [], configs: [] });
    const loaded = await loadTankHoldPoints(db, index, points, p3At(P3_DAYS).getTime(), new Set([tank.id]));
    const byStart = loaded.get(tank.id);
    const holds = index.episodesOf(tank.id, 'tank.hold').filter((e) => e.valid);
    expect(byStart?.size).toBeLessThan(holds.length);
    expect(byStart?.size).toBeLessThanOrEqual(TANK_STATIC_LEAK_DEFAULTS.referenceHolds + TANK_STATIC_LEAK_DEFAULTS.recentHolds);
    for (const [start, holdPoints] of byStart ?? []) {
      const hold = holds.find((h) => h.start === start);
      expect(hold).toBeDefined();
      expect(holdPoints).toEqual(tankHoldPoints(fullSeries, hold ?? { start, end: start }));
      expect(holdPoints).toHaveLength(hold?.features.n_points ?? -1);
    }
  }, 240_000);

  it('조치 효과 검증 신규 지표: 압축기 비에너지(comp.sec_kwh_per_kg) 전후 비교를 저장한다', async () => {
    const comp = fixture.assetIdOf('COMP1');
    const { actionId } = await registerMaintenanceAction(db, { siteId: fixture.siteId, assetId: comp, findingId: null, actionType: '압축기 밸브 점검', performedAt: p3At(10), expectedEffect: { metric: 'comp.sec_kwh_per_kg', direction: 'decrease', min_delta: 0, stabilization_days: 1, window_days: 7 }, source: 'manual', actor: ADMIN });
    const result = await runAnalysis(db, request(), { now: () => p3At(P3_DAYS + 0.3), stages: 'verify' });
    expect(result.stats.sites[0]?.verification?.checked).toBe(1);
    const verification = await db.selectFrom('om.action_verification').selectAll().where('action_id', '=', actionId).executeTakeFirstOrThrow();
    expect(verification.method).toBe('matched_before_after@1');
    expect(verification.before_stats).toMatchObject({ metric: 'comp.sec_kwh_per_kg', unit: 'kWh/kg' });
    expect((verification.before_stats as { n: number }).n).toBeGreaterThan(0);
    expect((verification.after_stats as { n: number }).n).toBeGreaterThan(0);
    expect(['improved', 'no_change', 'worse', 'insufficient_data']).toContain(verification.verdict);
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM om.action_verification WHERE action_id = ${actionId}`.execute(db);
    expect(rows[0]?.n).toBe(1);
  }, 240_000);
});
