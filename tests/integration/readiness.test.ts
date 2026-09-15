// 탐지 준비도 DB 입력 (hysol_test): lib/data/readiness.ts가 om.point·om.m_1h(첫 버킷·최근 30일 good/전체 샘플)로 만든 입력이
// 셀 판정(완결성·주기·이력·누락 메트릭)·확보 순위·CSV 행으로 이어지는지 확인한다.
// 픽스처: 분석 테스트 사이트의 전해조 스택 1개(전류·전압 60초, 온도·운전시간 300초)를 20일 적재하고 스택 전류 3일을 지운 뒤 롤업한다.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readinessCsvRows, SITE_ROW_CODE } from '@/lib/analytics/readiness';
import { getSiteReadiness, type ReadinessView } from '@/lib/data/readiness';
import { getPool } from '@/lib/db/pool';
import { drainDirty } from '@/lib/ingest/rollup';
import { ANALYSIS_BASE_MS, createAnalysisFixture, DAY_MS, dropAnalysisFixture, type AnalysisFixture } from '../support/analysis-fixture';
import { createTestDb } from '../support/ingest-fixture';

const DAYS = 20;
const GAP = { fromDay: 5, days: 3 } as const;
const STACK = 'ELZ1/STACK1';
const iso = (ms: number): string => new Date(ms).toISOString();

describe('탐지 준비도 DB 입력 (hysol_test)', () => {
  const db = createTestDb();
  let fixture: AnalysisFixture;
  const cellOf = (view: ReadinessView, assetCode: string, detectorId: string) => view.rows.find((r) => r.code === assetCode)?.cells.find((c) => c.detectorId === detectorId);

  beforeAll(async () => {
    fixture = await createAnalysisFixture(db, DAYS, DAYS + 1);
    const current = await db.selectFrom('om.point').select('id').where('id', 'in', [...fixture.pointIds]).where('metric_key', '=', 'stack.current').executeTakeFirstOrThrow();
    const gapStart = ANALYSIS_BASE_MS + GAP.fromDay * DAY_MS;
    await sql`DELETE FROM om.measurement WHERE point_id = ${current.id} AND ts >= ${iso(gapStart)}::timestamptz AND ts < ${iso(gapStart + GAP.days * DAY_MS)}::timestamptz`.execute(db);
    await drainDirty(db, { pointIds: fixture.pointIds });
  }, 120_000);

  afterAll(async () => {
    await dropAnalysisFixture(db);
    await db.destroy();
    await getPool().end(); // getSiteReadiness가 쓰는 앱 풀
  });

  it('데이터 끝 시각 기준: 결측 3일은 완결성 부족, 300초 포인트는 주기 부족, 20일 이력은 이력 부족으로 부분 준비', async () => {
    const view = await getSiteReadiness({ id: fixture.siteId }, ANALYSIS_BASE_MS + DAYS * DAY_MS);
    expect(view.pointCount).toBe(4);
    // 포인트가 없고 판정 대상 설비 종류도 아닌 상위 전해조(ELZ1)는 행으로 보이지 않는다
    expect(view.rows.map((r) => r.code)).toEqual([SITE_ROW_CODE, STACK]);

    const voltageRise = cellOf(view, STACK, 'el.voltage_rise');
    expect(voltageRise?.status).toBe('partial');
    const completeness = voltageRise?.reasons.find((r) => r.code === 'low_completeness');
    expect(completeness).toMatchObject({ metricKey: 'stack.current', required: 0.9 });
    expect(completeness?.code === 'low_completeness' ? completeness.completeness : null).toBeCloseTo((DAYS - GAP.days) / DAYS, 3);
    expect(voltageRise?.reasons.filter((r) => r.code === 'coarse_period')).toEqual([
      { code: 'coarse_period', metricKey: 'stack.temp', periodS: 300, requiredS: 60 },
      { code: 'coarse_period', metricKey: 'run.hours', periodS: 300, requiredS: 60 },
    ]);
    expect(voltageRise?.reasons).toContainEqual({ code: 'short_history', historyDays: DAYS, requiredDays: 30 });
    expect(voltageRise?.reasons.some((r) => r.code === 'low_completeness' && r.metricKey === 'stack.voltage')).toBe(false);

    // 비에너지 탐지기는 상위 전해조의 전력·수소 유량을 끌어 쓰는데 포인트가 없다 → 누락 메트릭 + 확보 순위
    expect(cellOf(view, STACK, 'el.sec_rise')).toMatchObject({ status: 'missing', missingMetrics: ['h2.flow.mass', 'ac.power'] });
    expect(cellOf(view, STACK, 'tank.static_leak')?.status).toBe('n/a');
    const flow = view.ranking.find((r) => r.metricKey === 'h2.flow.mass');
    expect(flow?.blockedCells).toBeGreaterThanOrEqual(1);
    expect(flow?.metricName).not.toBeNull();

    const cells = view.rows.flatMap((r) => r.cells);
    const csv = readinessCsvRows(cells);
    expect(csv).toHaveLength(cells.length + 1);
    const row = csv.find((values) => values[0] === STACK && values[2] === 'el.voltage_rise');
    expect(row?.[5]).toBe('partial');
    expect(String(row?.[8])).toContain('stack.temp 주기 300초 (기준 60초 이하)');
  });

  it('수신이 멈춘 뒤 30일이 지나면 최근 창에 샘플이 없어 완결성은 데이터 없음, 이력은 첫 버킷부터 센다', async () => {
    const nowMs = ANALYSIS_BASE_MS + (DAYS + 40) * DAY_MS;
    const view = await getSiteReadiness({ id: fixture.siteId }, nowMs);
    const voltageRise = cellOf(view, STACK, 'el.voltage_rise');
    expect(voltageRise?.status).toBe('partial');
    expect(voltageRise?.reasons).toContainEqual({ code: 'low_completeness', metricKey: 'stack.voltage', completeness: null, required: 0.9 });
    expect(voltageRise?.reasons.some((r) => r.code === 'short_history')).toBe(false);
  });
});
