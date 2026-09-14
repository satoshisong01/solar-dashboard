// 수집 API의 경계 경로: 본문 크기 413, DB 포화 429, 재처리 멱등, 먼 미래 파티션 자동 생성.
// 모든 요청은 올바르게 서명해 "인증 실패가 아니라 해당 경로 때문에" 응답이 나오는지 확인한다.
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_COMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES } from '@/lib/ingest/body';
import { handleIngestRequest, type IngestDeps } from '@/lib/ingest/handler';
import { QUALITY } from '@/lib/ingest/quality';
import { replayGateway } from '@/lib/ingest/replay';
import { signBatch } from '@/lib/ingest/signature';
import {
  createIngestFixture,
  createTestDb,
  dropIngestFixture,
  FIXTURE_POINTS,
  FIXTURE_UNMAPPED,
  fixtureEnvelope,
  signedRequest,
  testDeps,
  type IngestFixture,
} from '../support/ingest-fixture';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = Date.UTC(2026, 8, 12, 6); // 2026-09-12T06:00Z
/** 마이그레이션 사전 생성 범위(-3~+3개월·2025~2027년) 밖, 연 경계에 걸친 달 */
const FAR_PARTITIONS = ['measurement_y2031m12', 'measurement_y2032m01', 'm_1h_y2031', 'm_1h_y2032'] as const;

describe('수집 API 경계 경로 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: IngestFixture;

  const dropFarPartitions = async () => {
    for (const name of FAR_PARTITIONS) await sql`DROP TABLE IF EXISTS ${sql.table(`om.${name}`)}`.execute(db);
  };

  beforeAll(async () => {
    fixture = await createIngestFixture(db);
    await dropFarPartitions(); // 이전 실행이 중간에 멈춰 남긴 빈 파티션
  });
  afterAll(async () => {
    await dropIngestFixture(db);
    await dropFarPartitions();
    await db.destroy();
  });

  /** 임의 바이트 본문을 픽스처 키로 올바르게 서명한 요청 */
  function signedRawRequest(bytes: Uint8Array, nowMs: number): Request {
    const body = new Uint8Array(bytes); // BodyInit은 ArrayBuffer 기반 뷰만 받는다
    const signature = signBatch(fixture.keyId, fixture.secret, Math.floor(nowMs / 1000), body);
    return new Request('http://localhost/api/ingest/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...signature },
      body,
    });
  }

  async function send(request: Request, nowMs: number, overrides: Partial<IngestDeps> = {}) {
    const { deps, runScheduled } = testDeps(db, fixture, nowMs, overrides);
    const response = await handleIngestRequest(request, deps);
    return { response, body: (await response.json()) as Record<string, unknown>, runScheduled };
  }

  /** 픽스처 게이트웨이가 남긴 모든 수집 기록의 행 수 */
  async function storedCounts() {
    const gatewayPoints = sql`(SELECT id FROM om.point WHERE gateway_id = ${fixture.gatewayId})`;
    const { rows } = await sql<Record<'batches' | 'samples' | 'hourly' | 'dirty' | 'unmapped' | 'events', number>>`
      SELECT
        (SELECT count(*)::int FROM om.ingest_batch WHERE gateway_id = ${fixture.gatewayId}) AS batches,
        (SELECT count(*)::int FROM om.measurement WHERE point_id IN ${gatewayPoints}) AS samples,
        (SELECT count(*)::int FROM om.m_1h WHERE point_id IN ${gatewayPoints}) AS hourly,
        (SELECT count(*)::int FROM om.rollup_dirty WHERE point_id IN ${gatewayPoints}) AS dirty,
        (SELECT count(*)::int FROM om.unmapped_source WHERE gateway_id = ${fixture.gatewayId}) AS unmapped,
        (SELECT count(*)::int FROM om.event_log WHERE gateway_id = ${fixture.gatewayId}) AS events
    `.execute(db);
    return rows[0];
  }

  describe('413 payload_too_large', () => {
    it('압축 본문은 4MB까지 크기 검사를 통과하고(여기서는 gzip이 아니라 400) 1바이트 넘으면 413이며 저장하지 않는다', async () => {
      const now = BASE;
      const before = await storedCounts();

      const atLimit = await send(signedRawRequest(randomBytes(MAX_COMPRESSED_BYTES), now), now);
      expect(atLimit.response.status).toBe(400);
      expect(atLimit.body).toMatchObject({ status: 'error', error: 'invalid_body' });

      const overLimit = await send(signedRawRequest(randomBytes(MAX_COMPRESSED_BYTES + 1), now), now);
      expect(overLimit.response.status).toBe(413);
      expect(overLimit.body).toMatchObject({ status: 'error', error: 'payload_too_large' });
      expect(await storedCounts()).toEqual(before);
    });

    it('압축을 풀면 20MB를 넘는 본문(압축 폭탄)은 서명이 맞아도 413이고, 정확히 20MB는 적재한다', async () => {
      const now = BASE + HOUR;
      /** 공백으로 JSON 끝을 채워 압축 해제 크기를 bytes로 맞춘다 (JSON으로는 같은 봉투) */
      const paddedGzip = (envelope: unknown, bytes: number) => {
        const json = JSON.stringify(envelope);
        return gzipSync(Buffer.from(json + ' '.repeat(bytes - Buffer.byteLength(json)), 'utf8'));
      };
      const envelope = (value: number) => fixtureEnvelope(now, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [now - MINUTE], v: [value] }] });
      const before = await storedCounts();

      const bomb = paddedGzip(envelope(10), MAX_DECOMPRESSED_BYTES + 1);
      expect(bomb.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);
      const rejected = await send(signedRawRequest(bomb, now), now);
      expect(rejected.response.status).toBe(413);
      expect(rejected.body).toMatchObject({ status: 'error', error: 'payload_too_large', message: expect.stringContaining('압축을 푼') });
      expect(await rejected.runScheduled()).toBe(0);
      expect(await storedCounts()).toEqual(before);

      const atLimit = await send(signedRawRequest(paddedGzip(envelope(11), MAX_DECOMPRESSED_BYTES), now), now);
      expect(atLimit.response.status).toBe(200);
      expect(atLimit.body).toMatchObject({ status: 'accepted', accepted: 1 });
      await atLimit.runScheduled();
    });
  });

  describe('429 busy', () => {
    it('DB 풀이 포화면 저장 없이 429·Retry-After를 주고, 같은 배치를 다시 보내면 duplicate가 아니라 새로 적재된다', async () => {
      const now = BASE + 2 * HOUR + 5 * MINUTE;
      const envelope = fixtureEnvelope(now, {
        series: [
          { src: FIXTURE_POINTS.I_DC.sourceKey, unit: 'A', t0: BASE + 2 * HOUR, dt: MINUTE, v: [3, 3.5, 4] },
          { src: 'COMP1/VIB_RMS_429', unit: 'mm/s', ts: [BASE + 2 * HOUR], v: [1] },
        ],
        events: [{ src: 'GD1/ALARM', ts: BASE + 2 * HOUR, code: 'H2_LEAK_L1', severity: 'critical' }],
      });
      const request = () => signedRequest(envelope, { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: now });
      const before = await storedCounts();

      const busy = await send(request(), now, { isDbSaturated: () => true });
      expect(busy.response.status).toBe(429);
      expect(busy.response.headers.get('Retry-After')).toBe('5');
      expect(busy.body).toMatchObject({ status: 'error', error: 'busy' });
      expect(await busy.runScheduled()).toBe(0);
      expect(await storedCounts()).toEqual(before);

      const retried = await send(request(), now + 5_000);
      expect(retried.response.status).toBe(200);
      expect(retried.body).toEqual({ status: 'accepted', accepted: 3, duplicate: 0, rejected: 0, unmapped: 1, missing: 0, events: 1 });
      await retried.runScheduled();
      expect(await storedCounts()).toMatchObject({ batches: before.batches + 1, samples: before.samples + 3, events: before.events + 1 });
    });
  });

  describe('재처리 멱등', () => {
    /** 픽스처 게이트웨이 원시·롤업·dirty·인박스·배치의 행 수와 내용 지문 */
    async function fingerprint() {
      const gatewayPoints = sql`(SELECT id FROM om.point WHERE gateway_id = ${fixture.gatewayId})`;
      const { rows } = await sql<Record<'raw' | 'hourly' | 'inbox' | 'batches', string | null>>`
        SELECT
          (SELECT md5(string_agg(concat_ws('|', point_id, ts, value, quality), ',' ORDER BY point_id, ts)) FROM om.measurement WHERE point_id IN ${gatewayPoints}) AS raw,
          (SELECT md5(string_agg(concat_ws('|', point_id, bucket, n, n_good, v_min, v_max, v_avg, v_first, v_last, v_sum), ',' ORDER BY point_id, bucket)) FROM om.m_1h WHERE point_id IN ${gatewayPoints}) AS hourly,
          (SELECT md5(string_agg(concat_ws('|', source_key, unit, sample_count, first_seen_at, last_seen_at), ',' ORDER BY source_key)) FROM om.unmapped_source WHERE gateway_id = ${fixture.gatewayId}) AS inbox,
          (SELECT md5(string_agg(concat_ws('|', batch_id, n_accepted, n_unmapped, status), ',' ORDER BY batch_id)) FROM om.ingest_batch WHERE gateway_id = ${fixture.gatewayId}) AS batches
      `.execute(db);
      return { counts: await storedCounts(), digest: rows[0] };
    }

    it('매핑 뒤 재처리를 태그 지정으로 두 번, 전체로 한 번 더 실행해도 첫 재처리 뒤와 행 수·내용이 같다', async () => {
      const window = BASE + 6 * HOUR;
      const vib = FIXTURE_UNMAPPED.sourceKey;
      for (const [offset, values] of [[0, [1.25, 1.5, null]], [HOUR, [2.25, 2.5, 2.75]]] as const) {
        const sentAt = window + offset + 20 * MINUTE;
        const { response, runScheduled } = await send(
          signedRequest(
            fixtureEnvelope(sentAt, {
              series: [
                { src: vib, unit: 'mm/s', t0: window + offset, dt: 5 * MINUTE, v: [...values] },
                { src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', t0: window + offset, dt: 10 * MINUTE, v: [50, 51] },
              ],
            }),
            { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: sentAt },
          ),
          sentAt,
        );
        expect(response.status).toBe(200);
        await runScheduled();
      }
      const assetId = fixture.assetIds.get(FIXTURE_UNMAPPED.asset);
      if (assetId === undefined) throw new Error('COMP1 설비가 없습니다');
      const point = await db
        .insertInto('om.point')
        .values({ asset_id: assetId, metric_key: FIXTURE_UNMAPPED.metric, gateway_id: fixture.gatewayId, source_key: vib, source_unit: 'mm/s' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const first = await replayGateway(db, fixture.gatewayId, { from: new Date(window), sourceKeys: [vib] });
      expect(first).toMatchObject({ batches: 2, failed: 0, accepted: 5, duplicate: 0, missing: 1, rollup: { upserted: 2 } });
      const afterFirst = await fingerprint();
      expect(afterFirst.digest.raw).not.toBeNull();
      const filled = await db.selectFrom('om.measurement').select('quality').where('point_id', '=', point.id).execute();
      expect(filled).toHaveLength(5);
      expect(filled.every((row) => (row.quality & QUALITY.REPROCESSED) !== 0)).toBe(true);

      const second = await replayGateway(db, fixture.gatewayId, { from: new Date(window), sourceKeys: [vib] });
      expect(second).toMatchObject({ batches: 2, accepted: 0, duplicate: 5, rollup: { picked: 0 } });
      expect(await fingerprint()).toEqual(afterFirst);

      const everything = await replayGateway(db, fixture.gatewayId);
      expect(everything).toMatchObject({ failed: 0, accepted: 0, rollup: { picked: 0 } });
      expect(everything.duplicate).toBeGreaterThan(second.duplicate);
      expect(await fingerprint()).toEqual(afterFirst);
    });
  });

  describe('파티션 자동 생성', () => {
    async function partitionOf(table: 'measurement' | 'm_1h', column: 'ts' | 'bucket', atMs: number): Promise<string | undefined> {
      const { rows } = await sql<{ name: string }>`
        SELECT tableoid::regclass::text AS name FROM ${sql.table(`om.${table}`)}
        WHERE point_id = ${fixture.pointIds.SOC} AND ${sql.ref(column)} = ${new Date(atMs)}
      `.execute(db);
      return rows[0]?.name;
    }

    const existing = async () => {
      const { rows } = await sql<{ name: string }>`
        SELECT name FROM unnest(${[...FAR_PARTITIONS]}::text[]) AS name WHERE to_regclass('om.' || name) IS NOT NULL ORDER BY name
      `.execute(db);
      return rows.map((row) => row.name);
    };

    it('먼 미래의 연 경계(UTC)에 걸친 샘플은 월·연 파티션을 새로 만들어 넣고 DEFAULT에는 넣지 않는다', async () => {
      const lastOf2031 = Date.UTC(2031, 11, 31, 23, 50); // KST로는 2032-01-01이지만 파티션 경계는 UTC
      const firstOf2032 = Date.UTC(2032, 0, 1, 0, 10);
      const now = firstOf2032 + 5 * MINUTE;
      expect(await existing()).toEqual([]);

      const envelope = fixtureEnvelope(now, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [lastOf2031, firstOf2032], v: [61, 62] }] });
      const { response, body, runScheduled } = await send(signedRequest(envelope, { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: now }), now);
      await runScheduled();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ accepted: 2, rejected: 0 });
      expect(await existing()).toEqual([...FAR_PARTITIONS].sort());
      expect(await partitionOf('measurement', 'ts', lastOf2031)).toBe('om.measurement_y2031m12');
      expect(await partitionOf('measurement', 'ts', firstOf2032)).toBe('om.measurement_y2032m01');
      expect(await partitionOf('m_1h', 'bucket', Date.UTC(2031, 11, 31, 23))).toBe('om.m_1h_y2031');
      expect(await partitionOf('m_1h', 'bucket', Date.UTC(2032, 0, 1, 0))).toBe('om.m_1h_y2032');

      const { rows } = await sql<{ raw: number; hourly: number }>`
        SELECT
          (SELECT count(*)::int FROM om.measurement_default WHERE point_id = ${fixture.pointIds.SOC}) AS raw,
          (SELECT count(*)::int FROM om.m_1h_default WHERE point_id = ${fixture.pointIds.SOC}) AS hourly
      `.execute(db);
      expect(rows[0]).toEqual({ raw: 0, hourly: 0 });

      // 같은 달에 다시 보내도 파티션은 그대로다
      const again = fixtureEnvelope(now + MINUTE, { series: [{ src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', ts: [firstOf2032 + MINUTE], v: [63] }] });
      const second = await send(signedRequest(again, { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: now + MINUTE }), now + MINUTE);
      await second.runScheduled();
      expect(second.response.status).toBe(200);
      expect(await partitionOf('measurement', 'ts', firstOf2032 + MINUTE)).toBe('om.measurement_y2032m01');
      expect(await existing()).toEqual([...FAR_PARTITIONS].sort());
    });
  });
});
