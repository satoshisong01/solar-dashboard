// 운영 화면(안전·데이터·설정)의 DB 변경 로직. Server Action은 권한 확인 뒤 이 함수들을 부른다.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleIngestRequest } from '@/lib/ingest/handler';
import { revokeGatewayKey } from '@/lib/ingest/keys';
import { QUALITY } from '@/lib/ingest/quality';
import { createMetricDef, updateMetricDef } from '@/lib/ops/catalog';
import { createGateway, issueKeyForGateway } from '@/lib/ops/gateways';
import { createPointFromInbox, listPendingReplayTags, replayMappedTags } from '@/lib/ops/mapping';
import { upsertMarketRows } from '@/lib/ops/market';
import { ackSafetyEvent } from '@/lib/ops/safety';
import type { MetricDefInput } from '@/lib/forms/metric-def';
import {
  compareRollupWithRaw,
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
const BASE = Date.UTC(2026, 8, 13, 1); // 2026-09-13T01:00Z
const SECOND_UNMAPPED = 'COMP1/VIB_RMS_B';
const TEST_METRIC_KEY = 'itest.console.metric';
const MARKET_DAYS = ['2001-01-01', '2001-01-02'] as const;

describe('운영 화면 DB 변경 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: IngestFixture;
  const nowMs = BASE + 20 * MINUTE;

  beforeAll(async () => {
    fixture = await createIngestFixture(db);
    await cleanupExtras();
    const envelope = fixtureEnvelope(nowMs, {
      series: [
        { src: FIXTURE_POINTS.SOC.sourceKey, unit: '%', t0: BASE, dt: 5 * MINUTE, v: [40, 41, 42] },
        { src: FIXTURE_UNMAPPED.sourceKey, unit: 'mm/s', t0: BASE, dt: 5 * MINUTE, v: [1.1, 1.2, null, 1.4] },
        { src: SECOND_UNMAPPED, unit: 'mm/s', t0: BASE, dt: 5 * MINUTE, v: [2.1] },
      ],
      events: [
        { src: 'GD1/ALARM', ts: BASE + 7 * MINUTE, code: 'H2_LEAK_L1', severity: 'major', text: '1차 경보' },
        { src: 'ESS1/RACK01/STATUS', ts: BASE + 8 * MINUTE, code: 'W100', severity: 'minor' },
      ],
    });
    const { deps } = testDeps(db, fixture, nowMs);
    const response = await handleIngestRequest(signedRequest(envelope, { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: nowMs }), deps);
    expect(response.status).toBe(200);
  });

  afterAll(async () => {
    await cleanupExtras();
    await dropIngestFixture(db);
    await db.destroy();
  });

  async function cleanupExtras(): Promise<void> {
    await db.deleteFrom('om.market_daily').where(sql<string>`day::text`, 'in', [...MARKET_DAYS]).execute();
    await db.deleteFrom('om.metric_def').where('key', '=', TEST_METRIC_KEY).execute();
  }

  const eventIdOf = async (code: string) =>
    (await db.selectFrom('om.event_log').select(['id', 'received_at']).where('site_id', '=', fixture.siteId).where('code', '=', code).executeTakeFirstOrThrow());

  describe('안전 이벤트 확인', () => {
    it('수집 때 서버 수신 시각을 이벤트에 남긴다', async () => {
      expect((await eventIdOf('H2_LEAK_L1')).received_at?.getTime()).toBe(nowMs);
    });

    it('미확인 안전 이벤트만 메모·확인자와 함께 확인하고, 두 번째는 already_acked', async () => {
      const { id } = await eventIdOf('H2_LEAK_L1');
      const at = new Date(nowMs + MINUTE);
      expect(await ackSafetyEvent(db, { eventId: id, note: '현장 점검 완료', actor: 'ops@hysol.local', now: at })).toBe('acked');
      expect(await ackSafetyEvent(db, { eventId: id, note: '다시', actor: 'other@hysol.local' })).toBe('already_acked');

      const row = await db.selectFrom('om.event_log').select(['is_safety', 'acked_by', 'acked_at', 'ack_note']).where('id', '=', id).executeTakeFirstOrThrow();
      expect(row).toEqual({ is_safety: true, acked_by: 'ops@hysol.local', acked_at: at, ack_note: '현장 점검 완료' });
    });

    it('안전 이벤트가 아니거나 없는 id는 not_found이고 바꾸지 않는다', async () => {
      const { id } = await eventIdOf('W100');
      expect(await ackSafetyEvent(db, { eventId: id, note: 'x', actor: 'ops@hysol.local' })).toBe('not_found');
      expect(await ackSafetyEvent(db, { eventId: '9000000000000', note: 'x', actor: 'ops@hysol.local' })).toBe('not_found');
      const row = await db.selectFrom('om.event_log').select('acked_at').where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.acked_at).toBeNull();
    });
  });

  describe('미매핑 태그 매핑 → 재처리', () => {
    const mapping = (patch: Partial<Parameters<typeof createPointFromInbox>[1]> = {}) => ({
      gatewayId: fixture.gatewayId,
      sourceKey: FIXTURE_UNMAPPED.sourceKey,
      assetId: fixture.assetIds.get(FIXTURE_UNMAPPED.asset) ?? 0,
      metricKey: FIXTURE_UNMAPPED.metric,
      qualifier: '',
      scale: 1,
      valueOffset: 0,
      periodS: 300,
      ...patch,
    });

    it('인박스에 없는 태그, 다른 사이트 설비, 없는 메트릭은 포인트를 만들지 않는다', async () => {
      const otherSiteAsset = await db.selectFrom('om.asset').select('id').where('site_id', '<>', fixture.siteId).executeTakeFirstOrThrow();
      expect(await createPointFromInbox(db, mapping({ sourceKey: 'NOPE/TAG' }))).toEqual({ kind: 'inbox_missing' });
      expect(await createPointFromInbox(db, mapping({ assetId: otherSiteAsset.id }))).toEqual({ kind: 'asset_not_in_site' });
      expect(await createPointFromInbox(db, mapping({ metricKey: 'no.such.metric' }))).toEqual({ kind: 'metric_missing' });
      expect(await listPendingReplayTags(db, fixture.gatewayId)).toEqual([]);
    });

    it('포인트를 만들고 원본 단위를 인박스에서 가져온다. 같은 태그·같은 설비 메트릭은 다시 만들지 않는다', async () => {
      const created = await createPointFromInbox(db, mapping());
      expect(created).toMatchObject({ kind: 'created', assetId: mapping().assetId, siteCode: 'IT-INGEST' });
      if (created.kind !== 'created') return;

      const point = await db.selectFrom('om.point').selectAll().where('id', '=', created.pointId).executeTakeFirstOrThrow();
      expect(point).toMatchObject({ source_key: FIXTURE_UNMAPPED.sourceKey, source_unit: 'mm/s', metric_key: 'vibration.rms', period_s: 300 });

      expect(await createPointFromInbox(db, mapping())).toEqual({ kind: 'already_mapped' });
      expect(await createPointFromInbox(db, mapping({ sourceKey: SECOND_UNMAPPED }))).toEqual({ kind: 'duplicate_point' });
    });

    it('재처리는 매핑한 태그만 과거 값으로 채우고 롤업한 뒤 인박스에서 지운다', async () => {
      expect((await listPendingReplayTags(db, fixture.gatewayId)).map((tag) => tag.sourceKey)).toEqual([FIXTURE_UNMAPPED.sourceKey]);
      const socBefore = await db.selectFrom('om.measurement').select(sql<number>`count(*)::int`.as('n')).where('point_id', '=', fixture.pointIds.SOC).executeTakeFirstOrThrow();

      const result = await replayMappedTags(db, fixture.gatewayId);
      expect(result).toMatchObject({ kind: 'done', sourceKeys: [FIXTURE_UNMAPPED.sourceKey], clearedInbox: 1 });
      if (result.kind !== 'done') return;
      // 다른 태그(SOC 3개, 두 번째 미매핑 1개)는 후보에서 빠진다: 중복·미매핑 0
      expect(result.replay).toMatchObject({ batches: 1, failed: 0, accepted: 3, duplicate: 0, unmapped: 0, missing: 1 });

      const point = await db.selectFrom('om.point').select('id').where('source_key', '=', FIXTURE_UNMAPPED.sourceKey).executeTakeFirstOrThrow();
      const samples = await db.selectFrom('om.measurement').select(['value', 'quality']).where('point_id', '=', point.id).orderBy('ts').execute();
      expect(samples.map((s) => s.value)).toEqual([1.1, 1.2, 1.4]);
      expect(samples.every((s) => (s.quality & QUALITY.REPROCESSED) !== 0)).toBe(true);
      expect(await compareRollupWithRaw(db, [point.id])).toEqual({ buckets: 1, mismatches: 0 });

      const socAfter = await db.selectFrom('om.measurement').select(sql<number>`count(*)::int`.as('n')).where('point_id', '=', fixture.pointIds.SOC).executeTakeFirstOrThrow();
      expect(socAfter.n).toBe(socBefore.n);
      const inbox = await db.selectFrom('om.unmapped_source').select('source_key').where('gateway_id', '=', fixture.gatewayId).execute();
      expect(inbox.map((row) => row.source_key)).toEqual([SECOND_UNMAPPED]);
    });

    it('재처리 대기 태그가 없으면 nothing', async () => {
      expect(await replayMappedTags(db, fixture.gatewayId)).toEqual({ kind: 'nothing' });
    });
  });

  describe('시장가격 upsert', () => {
    it('새 행은 inserted, 같은 날짜·항목은 덮어써 updated로 센다', async () => {
      const rows = [
        { day: MARKET_DAYS[0], marketKey: 'smp_land', value: 142.35 },
        { day: MARKET_DAYS[1], marketKey: 'rec_avg', value: 71500 },
      ] as const;
      expect(await upsertMarketRows(db, rows, { source: 'manual', actor: 'ops@hysol.local' })).toEqual({ inserted: 2, updated: 0 });
      expect(await upsertMarketRows(db, [{ ...rows[0], value: 150 }], { source: 'csv', actor: 'csv@hysol.local' })).toEqual({ inserted: 0, updated: 1 });

      const stored = await db
        .selectFrom('om.market_daily')
        .select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'market_key', 'value', 'unit', 'source', 'updated_by'])
        .where(sql<string>`day::text`, 'in', [...MARKET_DAYS])
        .orderBy('day')
        .execute();
      expect(stored).toEqual([
        { day: '2001-01-01', market_key: 'smp_land', value: '150', unit: '원/kWh', source: 'csv', updated_by: 'csv@hysol.local' },
        { day: '2001-01-02', market_key: 'rec_avg', value: '71500', unit: '원/REC', source: 'manual', updated_by: 'ops@hysol.local' },
      ]);
    });
  });

  describe('메트릭 정의 추가·수정', () => {
    const def: MetricDefInput = {
      key: TEST_METRIC_KEY,
      nameKo: '테스트 메트릭',
      quantity: 'velocity',
      unit: 'mm/s',
      valueKind: 'gauge',
      rollup: 'avg',
      hardMin: 0,
      hardMax: 100,
      expectedMin: null,
      expectedMax: null,
      flatlineMaxS: 3600,
      aliases: ['VIB', 'RMS'],
    };

    it('추가 → 중복 키 거부 → 수정 → 없는 키 수정은 not_found', async () => {
      expect(await createMetricDef(db, def)).toBe('saved');
      expect(await createMetricDef(db, def)).toBe('duplicate_key');
      expect(await updateMetricDef(db, { ...def, nameKo: '고친 이름', aliases: [], hardMax: 50 })).toBe('saved');
      expect(await updateMetricDef(db, { ...def, key: 'itest.console.none' })).toBe('not_found');

      const row = await db.selectFrom('om.metric_def').selectAll().where('key', '=', TEST_METRIC_KEY).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ name_ko: '고친 이름', hard_max: 50, aliases: [], flatline_max_s: 3600 });
    });

    it('DB CHECK(물리 범위 역전)에 걸리면 invalid', async () => {
      expect(await updateMetricDef(db, { ...def, hardMin: 10, hardMax: 1 })).toBe('invalid');
    });
  });

  describe('게이트웨이·키', () => {
    it('게이트웨이 코드 중복과 없는 사이트를 거부한다', async () => {
      const created = await createGateway(db, { siteId: fixture.siteId, code: 'GW-IT-OPS-01' });
      expect(created.kind).toBe('created');
      expect(await createGateway(db, { siteId: fixture.siteId, code: 'GW-IT-OPS-01' })).toEqual({ kind: 'duplicate_code' });
      expect(await createGateway(db, { siteId: 32000, code: 'GW-IT-OPS-02' })).toEqual({ kind: 'site_missing' });
    });

    it('활성 키는 2개까지 발급되고, 하나를 폐기하면 다시 발급된다', async () => {
      const gateway = await db.selectFrom('om.gateway').select('id').where('code', '=', 'GW-IT-OPS-01').executeTakeFirstOrThrow();
      const first = await issueKeyForGateway(db, gateway.id, fixture.encryptionKey);
      const second = await issueKeyForGateway(db, gateway.id, fixture.encryptionKey);
      expect([first.kind, second.kind]).toEqual(['issued', 'issued']);
      expect(await issueKeyForGateway(db, gateway.id, fixture.encryptionKey)).toEqual({ kind: 'limit_reached' });
      expect(await issueKeyForGateway(db, 32000, fixture.encryptionKey)).toEqual({ kind: 'gateway_missing' });

      if (first.kind !== 'issued') return;
      expect(first.key.secret.length).toBeGreaterThanOrEqual(43);
      expect(await revokeGatewayKey(db, first.key.keyId)).toBe(true);
      expect((await issueKeyForGateway(db, gateway.id, fixture.encryptionKey)).kind).toBe('issued');
    });
  });
});
