import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleIngestRequest } from '@/lib/ingest/handler';
import { QUALITY } from '@/lib/ingest/quality';
import { replayGateway } from '@/lib/ingest/replay';
import { computeHourlyRollup } from '@/lib/ingest/rollup';
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
const HOUR = 60 * MINUTE;
const BASE = Date.UTC(2026, 8, 14, 9); // 2026-09-14T09:00Z

describe('롤업 재계산과 재처리 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: IngestFixture;

  beforeAll(async () => {
    fixture = await createIngestFixture(db);
  });
  afterAll(async () => {
    await dropIngestFixture(db);
    await db.destroy();
  });

  async function post(envelope: unknown, nowMs: number) {
    const { deps, runScheduled } = testDeps(db, fixture, nowMs);
    const response = await handleIngestRequest(signedRequest(envelope, { keyId: fixture.keyId, secret: fixture.secret, signedAtMs: nowMs }), deps);
    expect(response.status).toBe(200);
    return { body: (await response.json()) as Record<string, unknown>, runScheduled };
  }

  async function dirtyGen(pointId: number, bucketMs: number): Promise<string | undefined> {
    const row = await db
      .selectFrom('om.rollup_dirty')
      .select('gen')
      .where('point_id', '=', pointId)
      .where('bucket', '=', new Date(bucketMs))
      .executeTakeFirst();
    return row?.gen;
  }

  it('지연 도착 샘플이 들어오면 해당 시간 dirty gen이 올라가고 m_1h가 원시 재집계와 같아진다', async () => {
    const pointId = fixture.pointIds.I_DC;
    const src = FIXTURE_POINTS.I_DC.sourceKey;

    const onTime = await post(fixtureEnvelope(BASE + 25 * MINUTE, { series: [{ src, unit: 'A', t0: BASE, dt: 10 * MINUTE, v: [1.5, 2.5, 3.5] }] }), BASE + 25 * MINUTE);
    expect(await dirtyGen(pointId, BASE)).toBe('1');

    // 2시간 30분 뒤: 09시 버킷에 늦게 온 샘플 2개 + 11시 샘플 1개
    const lateAt = BASE + 2 * HOUR + 30 * MINUTE;
    const late = await post(
      fixtureEnvelope(lateAt, { series: [{ src, unit: 'A', ts: [BASE + 5 * MINUTE, BASE + 15 * MINUTE, BASE + 2 * HOUR + 10 * MINUTE], v: [4.25, 0.5, 7] }] }),
      lateAt,
    );
    expect(late.body).toMatchObject({ accepted: 3, duplicate: 0 });
    expect(await dirtyGen(pointId, BASE)).toBe('2');
    expect(await dirtyGen(pointId, BASE + 2 * HOUR)).toBe('1');

    await onTime.runScheduled();
    await late.runScheduled();

    const raw = await db.selectFrom('om.measurement').select(['ts', 'value', 'quality']).where('point_id', '=', pointId).where('ts', '<', new Date(BASE + HOUR)).execute();
    const expected = computeHourlyRollup(raw.map((row) => ({ tsMs: row.ts.getTime(), value: row.value ?? Number.NaN, quality: row.quality })));
    const rolled = await db.selectFrom('om.m_1h').selectAll().where('point_id', '=', pointId).where('bucket', '=', new Date(BASE)).executeTakeFirstOrThrow();

    expect(raw.filter((row) => row.quality === QUALITY.LATE)).toHaveLength(2);
    expect(expected).toEqual({ n: 5, nGood: 3, min: 0.5, max: 4.25, avg: 12.25 / 5, first: 1.5, last: 3.5, sum: 12.25 });
    expect(rolled).toMatchObject({
      n: expected.n,
      n_good: expected.nGood,
      v_min: expected.min,
      v_max: expected.max,
      v_avg: expected.avg,
      v_first: expected.first,
      v_last: expected.last,
      v_sum: expected.sum,
    });
    expect(await dirtyGen(pointId, BASE)).toBeUndefined();
    expect(await compareRollupWithRaw(db, [pointId])).toEqual({ buckets: 2, mismatches: 0 });
  });

  it('미매핑 태그를 인박스에 쌓았다가 포인트를 매핑하고 재처리하면 과거 값이 채워진다', async () => {
    const window = BASE + 12 * HOUR;
    const vib = FIXTURE_UNMAPPED.sourceKey;
    const first = await post(
      fixtureEnvelope(window + 10 * MINUTE, {
        series: [
          { src: vib, unit: 'mm/s', t0: window, dt: 5 * MINUTE, v: [1.25, 1.5, 1.75] },
          { src: FIXTURE_POINTS.I_DC.sourceKey, unit: 'A', ts: [window], v: [5] },
        ],
      }),
      window + 10 * MINUTE,
    );
    const second = await post(fixtureEnvelope(window + 70 * MINUTE, { series: [{ src: vib, unit: 'mm/s', ts: [window + 65 * MINUTE, window + 66 * MINUTE], v: [2.25, null] }] }), window + 70 * MINUTE);
    expect(second.body).toMatchObject({ accepted: 0, unmapped: 2 });
    await first.runScheduled();

    const inbox = await db.selectFrom('om.unmapped_source').select(['source_key', 'unit', 'sample_count']).where('gateway_id', '=', fixture.gatewayId).execute();
    expect(inbox).toEqual([{ source_key: vib, unit: 'mm/s', sample_count: '5' }]);

    const assetId = fixture.assetIds.get(FIXTURE_UNMAPPED.asset);
    if (assetId === undefined) throw new Error('COMP1 설비가 없습니다');
    const point = await db
      .insertInto('om.point')
      .values({ asset_id: assetId, metric_key: FIXTURE_UNMAPPED.metric, gateway_id: fixture.gatewayId, source_key: vib, source_unit: 'mm/s' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const replayed = await replayGateway(db, fixture.gatewayId, { from: new Date(window), chunkSize: 1 });

    expect(replayed).toEqual({
      batches: 2,
      failed: 0,
      accepted: 4,
      duplicate: 1,
      rejected: 0,
      unmapped: 0,
      missing: 1,
      rollup: { picked: 2, upserted: 2, cleared: 2 },
    });
    const filled = await db.selectFrom('om.measurement').select(['ts', 'value', 'quality']).where('point_id', '=', point.id).orderBy('ts').execute();
    expect(filled).toEqual([
      { ts: new Date(window), value: 1.25, quality: QUALITY.REPROCESSED },
      { ts: new Date(window + 5 * MINUTE), value: 1.5, quality: QUALITY.REPROCESSED },
      { ts: new Date(window + 10 * MINUTE), value: 1.75, quality: QUALITY.REPROCESSED },
      { ts: new Date(window + 65 * MINUTE), value: 2.25, quality: QUALITY.REPROCESSED },
    ]);
    expect(await compareRollupWithRaw(db, [point.id])).toEqual({ buckets: 2, mismatches: 0 });

    // 다시 재처리해도 원시는 늘지 않는다
    const again = await replayGateway(db, fixture.gatewayId, { from: new Date(window) });
    expect(again).toMatchObject({ batches: 2, accepted: 0, duplicate: 5, rollup: { picked: 0 } });
  });
});
