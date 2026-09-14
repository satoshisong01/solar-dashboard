// P2 분석·코칭 스키마(om)와 시뮬레이터 평가 스키마(sim)의 제약을 확인한다. 각 테스트는 트랜잭션 안에서 실행하고 되돌린다.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from '../support/test-env';

const databaseUrl = assertTestDatabaseUrl(process.env.DATABASE_URL);

const SCOPE = JSON.stringify({ siteIds: [1], from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' });

describe('P2 분석·코칭 스키마 (hysol_test)', () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  let siteId: number;
  let assetId: number;
  let runId: string;

  beforeAll(() => client.connect());
  afterAll(() => client.end());

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query("INSERT INTO om.asset_class (key, level, name_ko) VALUES ('test.p2rack', 'asset', 'P2 테스트 설비')");
    siteId = (await client.query<{ id: number }>("INSERT INTO om.site (code, name) VALUES ('TEST-P2', 'P2 스키마 테스트') RETURNING id")).rows[0]?.id ?? 0;
    assetId = (
      await client.query<{ id: number }>(
        "INSERT INTO om.asset (site_id, level, class_key, code, path, name) VALUES ($1, 'asset', 'test.p2rack', 'RACK1', 'TEST-P2/RACK1', '랙1') RETURNING id",
        [siteId],
      )
    ).rows[0]?.id ?? 0;
    runId = (await client.query<{ id: string }>("INSERT INTO om.analysis_run (requested_by, scope) VALUES ('admin@hysol.local', $1) RETURNING id", [SCOPE])).rows[0]?.id ?? '';
  });
  afterEach(() => client.query('ROLLBACK'));

  /** 실패해야 하는 문장을 세이브포인트 안에서 실행하고 오류 메시지를 확인한다 */
  async function expectRejected(text: string, params: readonly unknown[], pattern: RegExp): Promise<void> {
    await client.query('SAVEPOINT expect_rejected');
    await expect(client.query(text, [...params])).rejects.toThrow(pattern);
    await client.query('ROLLBACK TO SAVEPOINT expect_rejected');
  }

  const insertFinding = (overrides: Readonly<Record<string, unknown>> = {}) => {
    const row = {
      site_id: siteId,
      asset_id: assetId,
      detector_id: 'ess.capacity_fade',
      detector_version: '1',
      failure_mode: 'capacity_fade',
      category: 'degradation',
      dedup_key: `ess.capacity_fade:${assetId}:capacity_fade`,
      severity: 3,
      confidence: 0.8,
      status: 'new',
      title: '유효용량 감소',
      summary: '같은 조건 충전 18회 비교',
      window_start: '2026-08-01T00:00:00Z',
      window_end: '2026-09-01T00:00:00Z',
      first_detected_at: '2026-09-01T00:00:00Z',
      last_detected_at: '2026-09-01T00:00:00Z',
      dismiss_reason: null,
      previous_finding_id: null,
      ...overrides,
    };
    const columns = Object.keys(row);
    return {
      text: `INSERT INTO om.finding (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      params: Object.values(row),
    };
  };

  async function addFinding(overrides: Readonly<Record<string, unknown>> = {}): Promise<string> {
    const { text, params } = insertFinding(overrides);
    return (await client.query<{ id: string }>(text, params)).rows[0]?.id ?? '';
  }

  it('열린 finding은 dedup_key당 하나이고, 기각(사유 필수)한 뒤에는 같은 dedup_key로 재발 행을 만들 수 있다', async () => {
    const first = await addFinding();
    const duplicate = insertFinding();
    await expectRejected(duplicate.text, duplicate.params, /finding_open_dedup_key_uq/);

    await expectRejected('UPDATE om.finding SET status = $1 WHERE id = $2', ['dismissed', first], /violates check constraint/);
    await client.query("UPDATE om.finding SET status = 'dismissed', dismiss_reason = '운영 조건 변경' WHERE id = $1", [first]);

    await expect(addFinding({ previous_finding_id: first })).resolves.not.toBe('');
  });

  it('안전 카테고리는 severity 4 이상만, 신뢰도는 0~1만 허용한다', async () => {
    const lowSafety = insertFinding({ category: 'safety', severity: 3, dedup_key: 'safety-low' });
    const badConfidence = insertFinding({ confidence: 1.2, dedup_key: 'conf' });

    await expectRejected(lowSafety.text, lowSafety.params, /violates check constraint/);
    await expectRejected(badConfidence.text, badConfidence.params, /violates check constraint/);
    await expect(addFinding({ category: 'safety', severity: 4, dedup_key: 'safety-ok' })).resolves.not.toBe('');
  });

  it('latest_evidence_id는 같은 finding의 근거만 가리킬 수 있다', async () => {
    const mine = await addFinding();
    const other = await addFinding({ dedup_key: 'other' });
    const evidence = async (findingId: string) =>
      (
        await client.query<{ id: string }>(
          "INSERT INTO om.finding_evidence (finding_id, run_id, input_hash, snapshot) VALUES ($1, $2, 'sha256:abc', '{\"bins\": []}') RETURNING id",
          [findingId, runId],
        )
      ).rows[0]?.id ?? '';
    const otherEvidence = await evidence(other);
    const myEvidence = await evidence(mine);

    await expectRejected('UPDATE om.finding SET latest_evidence_id = $1 WHERE id = $2', [otherEvidence, mine], /finding_latest_evidence_fk/);
    await client.query('UPDATE om.finding SET latest_evidence_id = $1 WHERE id = $2', [myEvidence, mine]);
  });

  it('verified 전이는 system만 기록할 수 있다', async () => {
    const finding = await addFinding();
    const transition = "INSERT INTO om.finding_transition (finding_id, from_status, to_status, actor) VALUES ($1, 'action_taken', 'verified', $2)";

    await expectRejected(transition, [finding, 'admin@hysol.local'], /violates check constraint/);
    await client.query(transition, [finding, 'system']);
  });

  it('탐지기 설정은 (탐지기, 범위)마다 활성 버전 하나이고 범위 형식을 검사한다', async () => {
    const insert = 'INSERT INTO om.detector_config (detector_id, scope, version, params, active, created_by) VALUES ($1, $2, $3, $4, $5, $6)';
    await client.query(insert, ['ess.capacity_fade', 'default', 1, '{"min_sessions": 15}', true, 'admin']);
    await client.query(insert, ['ess.capacity_fade', `asset:${assetId}`, 1, '{}', true, 'admin']);

    await expectRejected(insert, ['ess.capacity_fade', 'default', 2, '{}', true, 'admin'], /detector_config_active_uq/);
    await expectRejected(insert, ['ess.capacity_fade', 'rack', 1, '{}', false, 'admin'], /violates check constraint/);
    await client.query(insert, ['ess.capacity_fade', 'class:ess.rack', 1, '{}', false, 'admin']);
  });

  it('분석 실행 범위에는 siteIds 배열과 from·to가 필요하고, running이면 종료 시각이 없어야 한다', async () => {
    const insert = 'INSERT INTO om.analysis_run (requested_by, scope, status, finished_at, error) VALUES ($1, $2, $3, $4, $5)';

    await expectRejected(insert, ['a', JSON.stringify({ from: 'x', to: 'y' }), 'running', null, null], /violates check constraint/);
    await expectRejected(insert, ['a', JSON.stringify({ siteIds: [], from: 'x', to: 'y' }), 'running', null, null], /violates check constraint/);
    await expectRejected(insert, ['a', SCOPE, 'running', '2030-01-01T00:00:00Z', null], /violates check constraint/);
    await expectRejected(insert, ['a', SCOPE, 'failed', '2030-01-01T00:00:00Z', null], /violates check constraint/);
    await client.query(insert, ['a', JSON.stringify({ siteIds: [1], assetIds: [2], from: 'x', to: 'y' }), 'succeeded', '2030-01-01T00:00:00Z', null]);
  });

  it('에피소드는 무효일 때만 사유를 갖고 종료가 시작보다 늦어야 한다', async () => {
    const insert = `INSERT INTO om.episode (asset_id, kind, start_ts, end_ts, extractor_version, valid, invalid_reason, run_id)
      VALUES ($1, 'ess.charge', $2, $3, 'ess-charge@1', $4, $5, $6)`;

    await expectRejected(insert, [assetId, '2026-09-01T00:00:00Z', '2026-09-01T08:00:00Z', false, null, runId], /violates check constraint/);
    await expectRejected(insert, [assetId, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', true, null, runId], /violates check constraint/);
    await client.query(insert, [assetId, '2026-09-01T00:00:00Z', '2026-09-01T08:00:00Z', true, null, runId]);
    await client.query(insert, [assetId, '2026-09-02T00:00:00Z', '2026-09-02T01:00:00Z', false, 'data_completeness<0.95', runId]);
  });

  it('조치의 기대 효과는 metric·direction·min_delta·stabilization_days를 모두 갖추고, 검증은 전 구간이 후 구간보다 앞서야 한다', async () => {
    const insertAction = `INSERT INTO om.maintenance_action (site_id, asset_id, action_type, performed_at, expected_effect, source, created_by)
      VALUES ($1, $2, 'cell_balancing', '2026-09-05T00:00:00Z', $3, 'manual', 'admin') RETURNING id`;
    const effect = { metric: 'ess.capacity_ah', direction: 'increase', min_delta: 5, stabilization_days: 7 };

    await expectRejected(insertAction, [siteId, assetId, JSON.stringify({ ...effect, direction: 'up' })], /violates check constraint/);
    await expectRejected(insertAction, [siteId, assetId, JSON.stringify({ metric: 'ess.capacity_ah', direction: 'increase' })], /violates check constraint/);
    const actionId = (await client.query<{ id: string }>(insertAction, [siteId, assetId, JSON.stringify(effect)])).rows[0]?.id;

    const insertVerification = `INSERT INTO om.action_verification (action_id, method, before_window, after_window, effect, verdict, run_id)
      VALUES ($1, 'matched_ratio', $2, $3, $4, $5, $6)`;
    const before = '[2026-08-01T00:00:00Z,2026-09-01T00:00:00Z)';
    const after = '[2026-09-12T00:00:00Z,2026-10-12T00:00:00Z)';
    await expectRejected(insertVerification, [actionId, after, before, 0.05, 'improved', runId], /violates check constraint/);
    await expectRejected(insertVerification, [actionId, before, after, null, 'improved', runId], /violates check constraint/);
    await client.query(insertVerification, [actionId, before, after, 0.05, 'improved', runId]);
    await expectRejected(insertVerification, [actionId, before, after, null, 'insufficient_data', runId], /action_verification_action_id_method_key/);
  });

  it('리포트는 같은 사이트·기간·composer·팩이면 하나이고, 사이트·기간마다 승인본은 하나다', async () => {
    const insert = `INSERT INTO om.report (site_id, period, composer_id, pack, pack_hash, draft, validation, status, created_by, approved_by, approved_at)
      VALUES ($1, '[2026-09-07T15:00:00Z,2026-09-14T15:00:00Z)', 'templateComposer@1', '{}', $2, '{}', '{}', $3, 'admin', $4, $5)`;
    const approved = (hash: string) => [siteId, hash, 'approved', 'admin', '2026-09-15T00:00:00Z'];

    await client.query(insert, approved('hash-1'));
    await expectRejected(insert, [siteId, 'hash-1', 'draft', null, null], /report_site_id_period_composer_id_pack_hash_key/);
    await expectRejected(insert, approved('hash-2'), /report_approved_uq/);
    await expectRejected(insert, [siteId, 'hash-3', 'approved', null, null], /violates check constraint/);
    await client.query(insert, [siteId, 'hash-2', 'draft', null, null]);
  });
});

describe('sim 스키마 (hysol_test)', () => {
  const client = new pg.Client({ connectionString: databaseUrl });

  beforeAll(() => client.connect());
  afterAll(() => client.end());
  afterEach(() => client.query('ROLLBACK'));

  it('실행·주입·평가 결과를 기록하고, 실행을 지우면 딸린 행도 지워진다', async () => {
    await client.query('BEGIN');
    const runId = (await client.query<{ id: string }>("INSERT INTO sim.run (seed, config, engine_version) VALUES (42, '{}', 'sim@1') RETURNING id")).rows[0]?.id;
    await client.query(
      `INSERT INTO sim.injection (run_id, site_code, asset_path, kind, start_ts, end_ts, params, expected_failure_modes)
       VALUES ($1, 'SIM-B', 'SIM-B/ESS1/RACK03', 'ess.capacity_fade', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '{"fade": 0.0625}', ARRAY['capacity_fade'])`,
      [runId],
    );
    await client.query(
      `INSERT INTO sim.eval_result (run_id, detector_id, tp, fp, fn, recall, precision, fp_per_asset_month, median_delay_days, magnitude_mae)
       VALUES ($1, 'ess.capacity_fade', 9, 0, 1, 0.9, 1, 0, 12.5, 0.004)`,
      [runId],
    );

    await client.query('DELETE FROM sim.run WHERE id = $1', [runId]);
    const { rows } = await client.query<{ injections: number; results: number }>(
      'SELECT (SELECT count(*) FROM sim.injection WHERE run_id = $1)::int AS injections, (SELECT count(*) FROM sim.eval_result WHERE run_id = $1)::int AS results',
      [runId],
    );
    expect(rows[0]).toEqual({ injections: 0, results: 0 });
  });
});
