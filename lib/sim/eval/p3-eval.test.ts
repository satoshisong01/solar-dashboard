import { describe, expect, it } from 'vitest';
import { computeHourlyRollup } from '@/lib/ingest/rollup';
import { QUALITY } from '@/lib/ingest/quality';
import type { MemorySeries } from '../memory';
import type { InjectionTruth } from '../truth';
import { evalSite } from './assets';
import { hourlyRows } from './hourly';
import { injectionResults, relatedWindowsOf } from './injections';
import { fanDelays, healthyResidualStats, leakMassBalanceShare, p3Gates, pvControlFindings, secPathSupport } from './p3-gates';
import { findingAssetId } from './records';
import { scoreAll } from './score';
import { SITE_ASSET_ID, type DetectionRecord, type InjectionResult, type SiteJobResult } from './types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00+09:00');

const truth = (overrides: Partial<InjectionTruth>): InjectionTruth => ({ siteCode: 'SIM-B', assetPath: 'SIM-B/ELZ1', kind: 'fault.elz_sec_rise', startTs: T0 + 10 * DAY, endTs: T0 + 100 * DAY, params: { pct: 6, mode: 'rectifier' }, expectedFailureModes: ['el.system_efficiency_loss'], expectedDetectors: ['el.sec_rise'], ...overrides });
const detection = (detectorId: string, day: number, assetId: number, extra: Partial<DetectionRecord> = {}): DetectionRecord => ({ ts: T0 + day * DAY, detectorId, assetId, failureMode: 'x', severity: 2, confidence: 0.8, effect: 1, ciLow: null, ciHigh: null, windows: null, ...extra });

function job(overrides: Partial<SiteJobResult>): SiteJobResult {
  return { jobId: 'j', seed: 1, siteCode: 'SIM-C', runIds: ['r'], fromMs: T0, toMs: T0 + 120 * DAY, checkpointTs: Array.from({ length: 13 }, (_, i) => T0 + (28 + 7 * i) * DAY), applicableAssets: {}, detections: [], injections: [], related: [], controls: [], tallies: [], capacityStatuses: [], stats: { simulationMs: 0, extractionMs: 0, detectionMs: 0, samples: 0, episodes: 0 }, ...overrides };
}

describe('메모리 시계열 1시간 롤업 = om.m_1h 규칙', () => {
  it('저장된 샘플(NaN 결측 제외)·good 수·값 통계가 computeHourlyRollup과 같다', () => {
    const ts = Float64Array.from({ length: 150 }, (_, i) => T0 + i * 60_000);
    const value = Float64Array.from({ length: 150 }, (_, i) => (i === 5 ? Number.NaN : 10 + Math.sin(i)));
    const quality = Int16Array.from({ length: 150 }, (_, i) => (i === 7 ? QUALITY.HARD_RANGE : 0));
    const series = { ts, value, quality, periodS: 60 } as unknown as MemorySeries;
    const rows = hourlyRows(series, 9, 'tank.temp');
    expect(rows.map((r) => r.hourStart)).toEqual([T0, T0 + 3_600_000, T0 + 7_200_000]);
    const first = computeHourlyRollup(Array.from({ length: 60 }, (_, i) => ({ tsMs: ts[i] as number, value: Number.isNaN(value[i] as number) ? null : (value[i] as number), quality: quality[i] as number })).filter((s) => s.value !== null));
    expect(rows[0]).toMatchObject({ assetId: 9, metricKey: 'tank.temp', periodS: 60, n: first.n, nGood: first.nGood, first: first.first, last: first.last, min: first.min, max: first.max });
    expect(rows[0]?.avg).toBeCloseTo(first.avg ?? 0, 12);
    expect(rows[0]).toMatchObject({ n: 59, nGood: 58 });
  });
});

describe('P3 채점: 사이트 단위·하위 설비·부수 탐지기', () => {
  const site = evalSite('SIM-B');
  const stack = site.byPath.get('SIM-B/ELZ1/STACK1')?.id ?? -1;

  it('전해조 설비 주입은 스택 finding과 맞추고, 사이트 단위 탐지기 주입은 설비 여러 개여도 한 건', () => {
    const detections = [detection('el.sec_rise', 40, stack, { failureMode: 'el.system_efficiency_loss' })];
    const ctx = { site, detections, soh: {}, outcomesAt: () => [] };
    const [sec] = injectionResults(ctx, [truth({})]);
    expect(sec).toMatchObject({ detectorId: 'el.sec_rise', assetId: stack });
    expect(sec?.firstDetectionTs).toBeNull(); // 하루 단위로 좁히는 재실행 결과가 없으면 null (outcomesAt 비어 있음)
    const soiling = ['PV1/INV01', 'PV1/INV02'].map((code) => truth({ siteCode: 'SIM-B', assetPath: `SIM-B/${code}`, kind: 'fault.pv_soiling', params: { pctPerDay: 0.1 }, expectedFailureModes: ['pv.soiling'], expectedDetectors: ['pv.soiling_rate'] }));
    expect(injectionResults(ctx, soiling).map((r) => [r.detectorId, r.assetId, r.magnitude])).toEqual([['pv.soiling_rate', SITE_ASSET_ID, 0.1]]);
    expect(findingAssetId({ detectorId: 'pv.soiling_rate', assetId: 123 })).toBe(SITE_ASSET_ID);
    expect(findingAssetId({ detectorId: 'tank.static_leak', assetId: 123 })).toBe(123);
    const related = relatedWindowsOf(site, [truth({ assetPath: 'SIM-B/H2BANK1/TANK2', kind: 'fault.tank_leak', relatedDetectors: ['h2chain.mass_balance_gap', 'tank.static_leak'] })]);
    expect(related.map((r) => [r.detectorId, r.assetIds])).toEqual([['h2chain.mass_balance_gap', [SITE_ASSET_ID]], ['tank.static_leak', [site.byPath.get('SIM-B/H2BANK1/TANK2')?.id]]]);
  });

  it('건강한 사이트 잔차 게이트·PV 대조군 finding·정류기 경로 적중률·누설 물질수지 비율·팬 지연', () => {
    const residuals = Array.from({ length: 100 }, (_, i) => ({ day: T0 + i * DAY, residualPct: i < 95 ? 0.5 : 1.9, completeness: i === 0 ? 0.5 : 1, producedKg: 40 }));
    const control = job({ ledgerResiduals: residuals, controls: [{ siteCode: 'SIM-C', assetPath: null, kind: 'control.cloudy_week', startTs: T0 + 50 * DAY, endTs: T0 + 57 * DAY, params: {}, confoundedDetectors: [] }], detections: [detection('pv.inverter_peer', 56, 5), detection('pv.inverter_peer', 70, 5), detection('tank.static_leak', 56, 5)] });
    expect(healthyResidualStats([control])).toMatchObject({ days: 99, median_pct: 0.5 });
    expect(pvControlFindings([control])).toBe(1);

    const secHit: InjectionResult = { injection: truth({}), detectorId: 'el.sec_rise', assetId: stack, magnitude: 6, unit: '%', firstDetectionTs: T0 + 40 * DAY, finalEffect: 6, trueEffect: 6 };
    const faradaic: InjectionResult = { ...secHit, injection: truth({ params: { pct: 6, mode: 'faradaic' } }) };
    const leak: InjectionResult = { injection: truth({ assetPath: 'SIM-B/H2BANK1/TANK2', kind: 'fault.tank_leak', params: { kgPerDay: 0.2 } }), detectorId: 'tank.static_leak', assetId: 7, magnitude: 0.2, unit: 'kg/일', firstDetectionTs: T0 + 30 * DAY, finalEffect: 0.2, trueEffect: 0.2 };
    const fan: InjectionResult = { injection: truth({ assetPath: 'SIM-A/PV1/INV02', kind: 'fault.inverter_fan_failure', startTs: T0 + 20 * DAY, params: { coolingLoss: 1 } }), detectorId: 'inv.thermal_derating', assetId: 3, magnitude: 1, unit: '냉각 저하 배율', firstDetectionTs: null, finalEffect: null, trueEffect: null };
    const faulty = job({
      siteCode: 'SIM-B',
      injections: [secHit, faradaic, leak, fan],
      detections: [detection('el.sec_rise', 40, stack, { supportedChecks: ['rectifier_efficiency'] }), detection('h2chain.mass_balance_gap', 45, SITE_ASSET_ID)],
    });
    expect(secPathSupport([faulty])).toMatchObject({ overall: 0.5, detected: 2, by_mode: { rectifier: { detected: 1, support_ratio: 1 }, faradaic: { detected: 1, support_ratio: 0 } } });
    expect(leakMassBalanceShare([faulty])).toEqual({ injections: 1, with_mass_balance_finding: 1, share: 1 });
    expect(fanDelays([faulty])).toEqual([{ start_day: 20, delays_days: [null] }]);

    const gates = p3Gates([control, faulty], scoreAll([control, faulty]));
    expect(gates.find((g) => g.id === 'h2chain.healthy_residual_median')).toMatchObject({ value: 0.5, pass: true });
    expect(gates.find((g) => g.id === 'pv.control_findings')).toMatchObject({ value: 1, pass: false });
    expect(gates.find((g) => g.id === 'el.sec_rise.recall_5pct')).toMatchObject({ value: 1, pass: true });
    expect(gates.find((g) => g.id === 'inv.thermal_derating.recall_fan_failure')).toMatchObject({ value: 0, pass: false });
    expect(gates.find((g) => g.id === 'comp.sec_rise.recall_valve_10pct')).toMatchObject({ value: null, pass: false });
    expect(gates.find((g) => g.id === 'tank.static_leak.min_detectable_kg_per_day')).toMatchObject({ value: 0.2, pass: true });
  });
});
