import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { handleIngestRequest, type IngestSuccessBody } from '@/lib/ingest/handler';
import { issueGatewayKey, revokeGatewayKey } from '@/lib/ingest/keys';
import { QUALITY } from '@/lib/ingest/quality';
import {
  compareRollupWithRaw,
  createIngestFixture,
  createTestDb,
  dropIngestFixture,
  FIXTURE_GATEWAY,
  FIXTURE_POINTS,
  FIXTURE_UNMAPPED,
  fixtureEnvelope,
  signedRequest,
  testDeps,
  type IngestFixture,
} from '../support/ingest-fixture';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = Date.UTC(2026, 8, 14, 3); // 2026-09-14T03:00Z

describe('POST /api/ingest/v1 처리 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: IngestFixture;

  beforeAll(async () => {
    fixture = await createIngestFixture(db);
  });
  afterAll(async () => {
    await dropIngestFixture(db);
    await db.destroy();
  });

  const pointIdList = () => Object.values(fixture.pointIds);
  const sign = (nowMs: number) => ({ keyId: fixture.keyId, secret: fixture.secret, signedAtMs: nowMs });

  async function post(envelope: unknown, nowMs: number, headers?: Record<string, string>) {
    const { deps, runScheduled } = testDeps(db, fixture, nowMs);
    const response = await handleIngestRequest(signedRequest(envelope, { ...sign(nowMs), headers }), deps);
    return { response, body: (await response.json()) as Record<string, unknown>, runScheduled };
  }

  async function countRows(from: number, to: number): Promise<number> {
    const row = await db
      .selectFrom('om.measurement')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('point_id', 'in', pointIdList())
      .where('ts', '>=', new Date(from))
      .where('ts', '<', new Date(to))
      .executeTakeFirstOrThrow();
    return row.n;
  }

  async function batchCount(): Promise<number> {
    const row = await db.selectFrom('om.ingest_batch').select(sql<number>`count(*)::int`.as('n')).where('gateway_id', '=', fixture.gatewayId).executeTakeFirstOrThrow();
    return row.n;
  }

  it('정상 배치: 샘플 정규화·품질 비트·미매핑·이벤트를 한 번에 기록하고 응답 뒤 롤업한다', async () => {
    const now = BASE + 5 * MINUTE;
    const envelope = fixtureEnvelope(now, {
      seq: 7,
      series: [
        { src: FIXTURE_POINTS.I_DC.sourceKey, unit: 'A', t0: BASE, dt: MINUTE, v: [10, 10.5, null, 11, 11.5, 12] },
        { src: FIXTURE_POINTS.I_DC.sourceKey, unit: 'A', ts: [now + 6 * MINUTE], v: [99] },
        { src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [BASE + 5_000, BASE + 65_000], v: [40.5, 41] },
        { src: FIXTURE_POINTS.V_CELL_MAX.sourceKey, unit: 'mV', t0: BASE, dt: MINUTE, v: [3312, 9999, 3300], q: [0, 0, 1] },
        { src: FIXTURE_UNMAPPED.sourceKey, unit: 'mm/s', t0: BASE, dt: MINUTE, v: [1.25, 1.5, 1.75] },
      ],
      events: [
        { src: 'GD1/ALARM', ts: BASE + MINUTE, code: 'H2_LEAK_L2', severity: 'major' },
        { src: 'ESS1/RACK01/FIRE', ts: BASE + MINUTE, code: 'FIRE_ALARM', severity: 'minor' },
        { src: 'ESS1/RACK01/BMS', ts: BASE + MINUTE, code: 'W101', severity: 'minor', text: '셀 편차 경고' },
        { src: 'H2BANK1/GAS_DET2', ts: BASE + 2 * MINUTE, code: 'H2_ALARM_L1', severity: 'critical' },
      ],
    });

    const { response, body, runScheduled } = await post(envelope, now);

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'accepted', accepted: 10, duplicate: 0, rejected: 1, unmapped: 3, missing: 1, events: 4 } satisfies IngestSuccessBody);
    expect(await countRows(BASE, BASE + HOUR)).toBe(10);

    const cells = await db.selectFrom('om.measurement').select(['value', 'quality']).where('point_id', '=', fixture.pointIds.V_CELL_MAX).orderBy('ts').execute();
    expect(cells).toEqual([
      { value: 3312 * 0.001, quality: 0 },
      { value: 9999 * 0.001, quality: QUALITY.HARD_RANGE },
      { value: 3300 * 0.001, quality: QUALITY.DEVICE_BAD },
    ]);

    const batch = await db.selectFrom('om.ingest_batch').selectAll().where('batch_id', '=', envelope.batch_id).executeTakeFirstOrThrow();
    expect(batch).toMatchObject({ seq: '7', n_samples: 15, n_accepted: 10, n_duplicate: 0, n_rejected: 1, n_unmapped: 3, n_events: 4, status: 'partial', skew_ms: 0 });

    const unmapped = await db.selectFrom('om.unmapped_source').select(['unit', 'sample_count']).where('gateway_id', '=', fixture.gatewayId).execute();
    expect(unmapped).toEqual([{ unit: 'mm/s', sample_count: '3' }]);

    const events = await db.selectFrom('om.event_log').select(['source_key', 'asset_id', 'is_safety', 'text']).where('gateway_id', '=', fixture.gatewayId).orderBy('source_key').execute();
    expect(events).toEqual([
      { source_key: 'ESS1/RACK01/BMS', asset_id: fixture.assetIds.get('ESS1/RACK01'), is_safety: false, text: '셀 편차 경고' },
      { source_key: 'ESS1/RACK01/FIRE', asset_id: fixture.assetIds.get('ESS1/RACK01'), is_safety: true, text: null },
      { source_key: 'GD1/ALARM', asset_id: fixture.assetIds.get('GD1'), is_safety: true, text: null },
      { source_key: 'H2BANK1/GAS_DET2', asset_id: null, is_safety: true, text: null },
    ]);

    const gateway = await db.selectFrom('om.gateway').select(['last_seq', 'last_seen_at', 'clock_offset_ms']).where('id', '=', fixture.gatewayId).executeTakeFirstOrThrow();
    expect(gateway).toEqual({ last_seq: '7', last_seen_at: new Date(now), clock_offset_ms: 0 });

    // 응답 뒤 작업(after): 이 배치 포인트의 dirty 버킷을 m_1h로 롤업
    expect(await runScheduled()).toBe(1);
    const dirty = await db.selectFrom('om.rollup_dirty').select('point_id').where('point_id', 'in', pointIdList()).execute();
    expect(dirty).toEqual([]);
    expect(await compareRollupWithRaw(db, pointIdList())).toEqual({ buckets: 3, mismatches: 0 });
  });

  it('같은 배치를 다시 보내면 duplicate로 응답하고 원시·미매핑·이벤트가 늘지 않는다', async () => {
    const now = BASE + HOUR + 5 * MINUTE;
    const envelope = fixtureEnvelope(now, {
      series: [
        { src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', t0: BASE + HOUR, dt: MINUTE, v: [50, 50.5, null] },
        { src: FIXTURE_UNMAPPED.sourceKey, unit: 'mm/s', t0: BASE + HOUR, dt: MINUTE, v: [2] },
      ],
      events: [{ src: 'GD1/ALARM', ts: BASE + HOUR, code: 'H2_LEAK_L1', severity: 'major' }],
    });
    const snapshot = async () => ({
      rows: await countRows(BASE + HOUR, BASE + 2 * HOUR),
      batches: await batchCount(),
      unmapped: (await db.selectFrom('om.unmapped_source').select('sample_count').where('gateway_id', '=', fixture.gatewayId).executeTakeFirstOrThrow()).sample_count,
      events: (await db.selectFrom('om.event_log').select(sql<number>`count(*)::int`.as('n')).where('gateway_id', '=', fixture.gatewayId).executeTakeFirstOrThrow()).n,
    });

    const first = await post(envelope, now);
    expect(first.body).toMatchObject({ status: 'accepted', accepted: 2, unmapped: 1, missing: 1, events: 1 });
    const before = await snapshot();

    const again = await post(envelope, now + MINUTE);

    expect(again.response.status).toBe(200);
    expect(again.body).toEqual({ status: 'duplicate', accepted: 0, duplicate: 4, rejected: 0, unmapped: 0, missing: 0, events: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await again.runScheduled()).toBe(0);
  });

  it('같은 batch_id로 본문이 다르면 409이고 두 번째 본문은 저장하지 않는다', async () => {
    const now = BASE + 2 * HOUR + 5 * MINUTE;
    const original = fixtureEnvelope(now, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [BASE + 2 * HOUR], v: [60] }] });
    const changed = { ...original, series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [BASE + 2 * HOUR, BASE + 2 * HOUR + MINUTE], v: [61, 62] }] };

    expect((await post(original, now)).response.status).toBe(200);
    const conflict = await post(changed, now);

    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ status: 'error', error: 'batch_conflict' });
    expect(await countRows(BASE + 2 * HOUR, BASE + 3 * HOUR)).toBe(1);
  });

  it('시계 오차는 서명 시각으로 잰다: sent_at이 오래된 재전송 본문도 서명 시각이 맞으면 정상, 서명 시각 +200초면 CLOCK_SUSPECT', async () => {
    const now = BASE + 3 * HOUR + 5 * MINUTE;
    const src = FIXTURE_POINTS.SOC.sourceKey;
    const stale = fixtureEnvelope(now - 2 * HOUR, { series: [{ src, unit: '%', ts: [BASE + 3 * HOUR], v: [70] }] });
    const skewed = fixtureEnvelope(now, { series: [{ src, unit: '%', ts: [BASE + 3 * HOUR + MINUTE], v: [71] }] });

    expect((await post(stale, now)).response.status).toBe(200);
    const { deps } = testDeps(db, fixture, now);
    expect((await handleIngestRequest(signedRequest(skewed, sign(now + 200_000)), deps)).status).toBe(200);

    const samples = await db
      .selectFrom('om.measurement')
      .select('quality')
      .where('point_id', '=', fixture.pointIds.SOC)
      .where('ts', '>=', new Date(BASE + 3 * HOUR))
      .where('ts', '<', new Date(BASE + 4 * HOUR))
      .orderBy('ts')
      .execute();
    expect(samples).toEqual([{ quality: 0 }, { quality: QUALITY.CLOCK_SUSPECT }]);
    const batches = await db.selectFrom('om.ingest_batch').select(['batch_id', 'skew_ms']).where('batch_id', 'in', [stale.batch_id, skewed.batch_id]).execute();
    expect(Object.fromEntries(batches.map((b) => [b.batch_id, b.skew_ms]))).toEqual({ [stale.batch_id]: 0, [skewed.batch_id]: 200_000 });
  });

  it('샘플 달의 파티션이 없으면 만든 뒤 DEFAULT가 아니라 그 파티션에 적재한다', async () => {
    const future = Date.UTC(2028, 1, 10, 6); // 마이그레이션 사전 생성 범위 밖
    const envelope = fixtureEnvelope(future, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [future - MINUTE], v: [55] }] });

    const { response, runScheduled } = await post(envelope, future);
    await runScheduled();

    expect(response.status).toBe(200);
    const { rows } = await sql<{ raw: string; rolled: string }>`
      SELECT
        (SELECT tableoid::regclass::text FROM om.measurement WHERE point_id = ${fixture.pointIds.SOC} AND ts = ${new Date(future - MINUTE)}) AS raw,
        (SELECT tableoid::regclass::text FROM om.m_1h WHERE point_id = ${fixture.pointIds.SOC} AND bucket = ${new Date(future - HOUR)}) AS rolled
    `.execute(db);
    expect(rows).toEqual([{ raw: 'om.measurement_y2028m02', rolled: 'om.m_1h_y2028' }]);
  });

  describe('인증 실패는 401과 X-OM-Server-Time을 돌려주고 아무것도 저장하지 않는다', () => {
    const now = BASE + 3 * HOUR + 5 * MINUTE;
    const envelope = () => fixtureEnvelope(now, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [BASE + 3 * HOUR], v: [70] }] });

    async function expectUnauthorized(request: Request, error: string) {
      const batchesBefore = await batchCount();
      const { deps } = testDeps(db, fixture, now);
      const response = await handleIngestRequest(request, deps);

      expect(response.status).toBe(401);
      expect(response.headers.get('X-OM-Server-Time')).toBe(String(Math.floor(now / 1000)));
      expect(await response.json()).toMatchObject({ status: 'error', error });
      expect(await batchCount()).toBe(batchesBefore);
    }

    it('서명이 틀리면 bad_signature', async () => {
      const request = signedRequest(envelope(), { ...sign(now), headers: { 'X-OM-Signature': `v1=${'0'.repeat(64)}` } });
      await expectUnauthorized(request, 'bad_signature');
    });

    it('다른 비밀값으로 서명하면 bad_signature', async () => {
      await expectUnauthorized(signedRequest(envelope(), { ...sign(now), secret: `${fixture.secret}x` }), 'bad_signature');
    });

    it('서명 시각이 300초 넘게 어긋나면 clock_skew', async () => {
      await expectUnauthorized(signedRequest(envelope(), { ...sign(now - 301_000) }), 'clock_skew');
    });

    it('서명 헤더가 없으면 signature_missing', async () => {
      await expectUnauthorized(signedRequest(envelope(), { ...sign(now), headers: { 'X-OM-Signature': '' } }), 'signature_missing');
    });

    it('없는 키나 폐기된 키면 unknown_key', async () => {
      const spare = await issueGatewayKey(db, { gatewayId: fixture.gatewayId, encryptionKey: fixture.encryptionKey });
      expect(await revokeGatewayKey(db, spare.keyId)).toBe(true);

      await expectUnauthorized(signedRequest(envelope(), { keyId: 'gk_nope', secret: fixture.secret, signedAtMs: now }), 'unknown_key');
      await expectUnauthorized(signedRequest(envelope(), { keyId: spare.keyId, secret: spare.secret, signedAtMs: now }), 'unknown_key');
    });

    it('봉투 gateway가 키의 게이트웨이와 다르면 gateway_mismatch', async () => {
      await expectUnauthorized(signedRequest({ ...envelope(), gateway: 'GW-SIMB-01' }, sign(now)), 'gateway_mismatch');
    });
  });

  describe('요청 형식 오류', () => {
    const now = BASE + 4 * HOUR;

    it('Content-Encoding: gzip이 없으면 400 gzip_required', async () => {
      const request = signedRequest(fixtureEnvelope(now, { series: [] }), { ...sign(now), headers: { 'Content-Encoding': 'identity' } });
      const response = await handleIngestRequest(request, testDeps(db, fixture, now).deps);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'gzip_required' });
    });

    it('서명은 맞지만 스키마가 틀리면 400과 오류 목록 (재시도 금지)', async () => {
      const bad = { ...fixtureEnvelope(now, { series: [] }), series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [now, now + 1], v: [1] }] };
      const { response, body } = await post(bad, now);

      expect(response.status).toBe(400);
      expect(body).toMatchObject({ error: 'invalid_envelope', issues: [expect.stringMatching(/^series\.0\.ts: ts 길이/)] });
    });

    it('압축 본문이 4MB를 넘으면 413', async () => {
      const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);
      const request = new Request('http://localhost/api/ingest/v1', {
        method: 'POST',
        headers: signedRequestHeaders(now),
        body: oversized,
      });
      const response = await handleIngestRequest(request, testDeps(db, fixture, now).deps);

      expect(response.status).toBe(413);
    });

    it('DB 풀 대기열이 가득 차면 429와 Retry-After', async () => {
      const request = signedRequest(fixtureEnvelope(now, { series: [] }), sign(now));
      const response = await handleIngestRequest(request, testDeps(db, fixture, now, { isDbSaturated: () => true }).deps);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('5');
    });

    function signedRequestHeaders(nowMs: number): Record<string, string> {
      const request = signedRequest({ gateway: FIXTURE_GATEWAY }, sign(nowMs));
      return Object.fromEntries(request.headers.entries());
    }
  });
});
