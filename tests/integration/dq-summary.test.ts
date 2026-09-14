// 데이터 품질 요약 (hysol_test): DB 경로(1시간 롤업 + 고착 SQL)와 메모리 평가 경로(lib/analytics/dq/summary.ts)가 같은 원시에서 같은 요약을 만든다.
// 픽스처 전해조 스택 원시에 6시간 고착(스택 온도, 기준 6시간)·5시간 55분 고착(기준 미달)·4시간 결측(스택 전류)을 넣는다.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryDqInput } from '@/lib/analytics/dq/summary';
import { loadSitePoints, type PointRow } from '@/lib/analysis/catalog';
import { loadDqInput } from '@/lib/analysis/dq-summary';
import { drainDirty } from '@/lib/ingest/rollup';
import { ANALYSIS_BASE_MS, createAnalysisFixture, DAY_MS, dropAnalysisFixture, type AnalysisFixture } from '../support/analysis-fixture';
import { createTestDb } from '../support/ingest-fixture';

const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('데이터 품질 요약 DB 경로 = 메모리 경로 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: AnalysisFixture;
  let points: PointRow[];

  beforeAll(async () => {
    fixture = await createAnalysisFixture(db, 4, 3);
    points = await loadSitePoints(db, fixture.siteId);
    const byMetric = (metric: string) => points.find((p) => p.metricKey === metric)?.pointId ?? 0;
    const stuck = async (pointId: number, from: number, to: number, value: number) =>
      sql`UPDATE om.measurement SET value = ${value} WHERE point_id = ${pointId} AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz`.execute(db);
    // 롤업 전에 원시를 바꾼다 (픽스처는 dirty만 표시하고 롤업하지 않는다)
    await stuck(byMetric('stack.temp'), ANALYSIS_BASE_MS + 10 * HOUR_MS, ANALYSIS_BASE_MS + 16 * HOUR_MS, 44.4);
    await stuck(byMetric('stack.temp'), ANALYSIS_BASE_MS + DAY_MS + 12 * HOUR_MS, ANALYSIS_BASE_MS + DAY_MS + 12 * HOUR_MS + 355 * 60_000, 41.1);
    await sql`DELETE FROM om.measurement WHERE point_id = ${byMetric('stack.current')} AND ts >= ${iso(ANALYSIS_BASE_MS + 2 * DAY_MS + 3 * HOUR_MS)}::timestamptz AND ts < ${iso(ANALYSIS_BASE_MS + 2 * DAY_MS + 7 * HOUR_MS)}::timestamptz`.execute(db);
    await drainDirty(db, { pointIds: fixture.pointIds });
  }, 120_000);

  afterAll(async () => {
    await dropAnalysisFixture(db);
    await db.destroy();
  });

  it('결측 구간·받은 샘플 수·고착 구간(끝 = 마지막 샘플 + 주기, 길이 ≥ 기준)이 같다', async () => {
    const requested = { start: ANALYSIS_BASE_MS, end: ANALYSIS_BASE_MS + 4 * DAY_MS };
    const fromDb = await loadDqInput(db, fixture.siteId, points, requested);
    if (!fromDb) throw new Error('DB 요약이 없습니다');
    const { rows } = await sql<{ point_id: number; ts_ms: number; value: number | null }>`
      SELECT point_id, (extract(epoch FROM ts) * 1000)::float8 AS ts_ms, value FROM om.measurement
      WHERE point_id = ANY(${fixture.pointIds}::int4[]) AND ts >= ${iso(fromDb.window.start)}::timestamptz AND ts < ${iso(fromDb.window.end)}::timestamptz
      ORDER BY point_id, ts
    `.execute(db);
    const memoryPoints = points.map((meta) => {
      const own = rows.filter((row) => row.point_id === meta.pointId);
      return { meta, ts: own.map((row) => row.ts_ms), values: own.map((row) => row.value ?? Number.NaN) };
    });
    const fromMemory = memoryDqInput(fixture.siteId, memoryPoints, fromDb.window);
    expect(fromMemory.points).toEqual(fromDb.points);

    const temp = fromDb.points.find((p) => p.metricKey === 'stack.temp');
    expect(temp?.flatlines).toEqual([{ start: ANALYSIS_BASE_MS + 10 * HOUR_MS, end: ANALYSIS_BASE_MS + 16 * HOUR_MS, value: 44.4 }]);
    const current = fromDb.points.find((p) => p.metricKey === 'stack.current');
    expect(current?.gaps).toEqual([{ start: ANALYSIS_BASE_MS + 2 * DAY_MS + 3 * HOUR_MS, end: ANALYSIS_BASE_MS + 2 * DAY_MS + 7 * HOUR_MS }]);
  }, 60_000);
});
