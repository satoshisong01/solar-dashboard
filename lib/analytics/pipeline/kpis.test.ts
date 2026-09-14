import { describe, expect, it } from 'vitest';
import { chargeSession, elRuns, fcRuns, pvDay } from '../detectors/test-fixtures';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR } from '../types';
import { dailyKpiRows, type HourlyPointRow } from './kpis';
import type { PipelineAsset, StoredEpisode } from './types';

const DAY = kstDayStart(Date.UTC(2026, 0, 5, 3));
const asset = (id: number, classKey: string, nameplate: Record<string, number>): PipelineAsset => ({ id, siteId: 1, parentId: null, code: `A${id}`, classKey, peerGroup: null, nameplate, commissionedAt: null });
const hourly = (assetId: number, metricKey: string, hour: number, avg: number, first = avg, last = avg): HourlyPointRow => ({ assetId, metricKey, periodS: 60, hourStart: DAY + hour * MS_PER_HOUR, n: 60, nGood: 60, avg, first, last });

describe('dailyKpiRows', () => {
  it('인버터 발전량·비발전량·동종 비율·가용률, 사이트 합계를 KST 일 단위로 만든다', () => {
    const inverters = [1, 2, 3].map((i) => asset(i, 'pv.inverter', { dc_kwp: 100, ac_kw: 100 }));
    const rows = dailyKpiRows({
      siteId: 9,
      assets: inverters,
      episodes: inverters.map((inv) => ({ ...pvDay(inv.id, 0, 4), start: DAY, end: DAY + MS_PER_DAY })),
      hourly: inverters.flatMap((inv) => [10, 11, 12].map((h) => hourly(inv.id, 'ac.power', h, 50 * inv.id))),
      window: { start: DAY + 5 * MS_PER_HOUR, end: DAY + 20 * MS_PER_HOUR },
    });
    const pick = (scope: string, id: number, key: string) => rows.find((r) => r.scopeType === scope && r.scopeId === id && r.kpi.key === key)?.kpi.value;
    expect(rows.every((r) => r.day === '2026-01-05')).toBe(true);
    expect(pick('asset', 2, 'pv.kwh')).toBe(300);
    expect(pick('asset', 2, 'pv.specific_yield_kwh_kwp')).toBe(3);
    expect(pick('asset', 1, 'pv.inverter_peer_ratio')).toBeCloseTo(0.5, 9);
    expect(pick('asset', 3, 'availability')).toBeCloseTo(1, 9);
    expect(pick('site', 9, 'pv.kwh')).toBe(900);
    expect(pick('site', 9, 'pv.specific_yield_kwh_kwp')).toBe(3);
  });

  it('랙 왕복효율·전해조 SEC·연료전지 원단위, 입력이 없는 KPI는 행을 만들지 않는다', () => {
    const rack = asset(7, 'ess.rack', { energy_kwh: 500 });
    const charge = { ...chargeSession({ day: 0, capacityAh: 600 }), start: DAY + 9 * MS_PER_HOUR, features: { ...chargeSession({ day: 0, capacityAh: 600 }).features, wh_in: 400_000 } };
    const discharge = { ...charge, kind: 'ess.discharge', start: DAY + 19 * MS_PER_HOUR, features: { wh_out: 360_000 } } as unknown as StoredEpisode;
    const stack = asset(31, 'h2.elz.stack', { rated_current_a: 1100, active_area_cm2: 550 });
    const fc = asset(41, 'fc.stack', { rated_current_a: 820, active_area_cm2: 800 });
    const rows = dailyKpiRows({
      siteId: 9,
      assets: [rack, stack, fc, asset(50, 'wx.station', {})],
      episodes: [charge, discharge, ...elRuns({ count: 3, startHours: 1200, endHours: 1210, rateUvPerH: 0, seed: 1 }).map((e) => ({ ...e, start: DAY + MS_PER_HOUR })), ...fcRuns({ count: 2, startHours: 600, endHours: 610, rateUvPerH: 0, seed: 1 }).map((e) => ({ ...e, start: DAY + MS_PER_HOUR }))],
      hourly: [hourly(7, 'batt.soc', 0, 20, 20, 20), hourly(7, 'batt.soc', 23, 30, 30, 30)],
      window: { start: DAY, end: DAY + MS_PER_DAY },
    });
    const keys = rows.map((r) => `${r.scopeId}:${r.kpi.key}`);
    // 합성 전해조 구간은 전류밀도 0.6~1.4 A/cm²라 기준 전류밀도(정격 2 A/cm²의 90% ± 10%) 셀 전압은 입력이 없어 행이 없다
    expect(keys).toEqual(['7:ess.rte', '31:elz.sec_kwh_per_kg', '41:fc.kg_per_mwh', '41:fc.v_cell_ref']);
    expect(rows[0]?.kpi.value).toBeCloseTo(360 / (400 - 50), 9);
    expect(rows[1]?.kpi.value).toBeCloseTo(50, 9);
  });
});
