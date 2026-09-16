import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../detectors';
import type { PipelineAsset } from '../pipeline/types';
import { cellDisplay, readyRatioText, withRelatedDetectors } from './display';
import { metricAcquisitionRanking } from './ranking';
import { requirementsFromDetectors } from './registry';
import { pointStatOf, relatedPoints, SITE_ROW_CODE, siteReadinessRows, type SitePointStat } from './site';
import type { ReadinessCell } from './types';

const asset = (id: number, code: string, classKey: string, parentId: number | null = null): PipelineAsset => ({ id, siteId: 2, parentId, code, classKey, peerGroup: null, nameplate: {}, commissionedAt: null });

const SITE: readonly PipelineAsset[] = [
  asset(1, 'PV1', 'pv.plant'),
  asset(2, 'PV1/INV01', 'pv.inverter', 1),
  asset(3, 'PV1/INV02', 'pv.inverter', 1),
  asset(4, 'WX1', 'wx.station'),
  asset(5, 'ESS1', 'ess.plant'),
  asset(6, 'ESS1/RACK01', 'ess.rack', 5),
  asset(7, 'ESS1/RACK02', 'ess.rack', 5),
  asset(8, 'H2BANK1', 'h2.storage.bank'),
  asset(9, 'H2BANK1/TANK1', 'h2.storage.tank', 8),
];

const stat = (assetId: number, metricKey: string, periodS = 60, completeness: number | null = 1, historyDays = 120): SitePointStat => ({ assetId, metricKey, periodS, completeness, historyDays });

const INVERTER = ['ac.power', 'ac.power.limit', 'op.state', 'heatsink.temp'];
const RACK = ['batt.current', 'batt.voltage', 'batt.soc', 'cell.temp.avg', 'cell.voltage.max', 'cell.voltage.min'];
const POINTS: readonly SitePointStat[] = [
  ...INVERTER.map((m) => stat(2, m)),
  ...INVERTER.filter((m) => m !== 'heatsink.temp').map((m) => stat(3, m)),
  ...['poa.irradiance', 'ambient.temp', 'module.temp'].map((m) => stat(4, m, 300)),
  ...RACK.map((m) => stat(6, m)),
  ...RACK.filter((m) => m !== 'cell.voltage.min').map((m) => stat(7, m, 60, m === 'batt.soc' ? 0.5 : 1)),
  stat(8, 'valve.open#inlet', 300),
  stat(8, 'valve.open#outlet', 300),
  stat(9, 'tank.pressure', 300),
  stat(9, 'tank.temp', 300),
];

const REQUIREMENTS = requirementsFromDetectors(DETECTORS);
const ROWS = siteReadinessRows(SITE, POINTS, REQUIREMENTS);
const cellOf = (code: string, detectorId: string): ReadinessCell => {
  const cell = ROWS.find((r) => r.code === code)?.cells.find((c) => c.detectorId === detectorId);
  if (!cell) throw new Error(`셀 없음 ${code} ${detectorId}`);
  return cell;
};

describe('siteReadinessRows', () => {
  it('사이트 행이 맨 앞, 설비 행은 경로순이며 포인트도 대상도 아닌 묶음 설비는 뺀다', () => {
    expect(ROWS.map((r) => r.code)).toEqual([SITE_ROW_CODE, 'ESS1/RACK01', 'ESS1/RACK02', 'H2BANK1', 'H2BANK1/TANK1', 'PV1/INV01', 'PV1/INV02', 'WX1']);
    expect(ROWS.every((r) => r.cells.length === REQUIREMENTS.length)).toBe(true);
  });

  it('사이트 행: 사이트 단위 탐지기만 판정하고, 요구 설비 종류가 전혀 없으면 n/a', () => {
    // 일사계 GHI는 권장 메트릭이라 없어도 ready다 (판별 체크 ②만 못 한다)
    expect(cellOf(SITE_ROW_CODE, 'pv.soiling_rate')).toMatchObject({ status: 'ready', assetId: 0, assetClass: 'site', recommendedMissing: ['ghi.irradiance'] });
    // 전해조·연료전지가 없어도 저장용기가 있으면 적용 → 수소 유량·소비 메트릭 누락
    expect(cellOf(SITE_ROW_CODE, 'h2chain.mass_balance_gap')).toMatchObject({ status: 'missing', missingMetrics: ['h2.flow.mass', 'fc.h2.consumption'] });
    expect(cellOf(SITE_ROW_CODE, 'ess.capacity_fade').status).toBe('n/a');
    const noH2 = siteReadinessRows(SITE.filter((a) => !a.classKey.startsWith('h2.')), POINTS, REQUIREMENTS);
    expect(noH2[0]?.cells.find((c) => c.detectorId === 'h2chain.mass_balance_gap')?.status).toBe('n/a');
  });

  it('설비 행: 대상 종류만 판정, 관련 설비 포인트(사이트 기상 외기 온도)를 합쳐 보고 사이트 단위 탐지기는 n/a', () => {
    expect(cellOf('PV1/INV01', 'inv.thermal_derating').status).toBe('ready');
    expect(cellOf('PV1/INV02', 'inv.thermal_derating')).toMatchObject({ status: 'missing', missingMetrics: ['heatsink.temp'] });
    expect(cellOf('PV1/INV01', 'pv.soiling_rate').status).toBe('n/a');
    expect(cellOf('PV1/INV01', 'ess.capacity_fade').status).toBe('n/a');
    expect(cellOf('ESS1/RACK01', 'ess.capacity_fade').status).toBe('ready');
    expect(cellOf('ESS1/RACK02', 'ess.capacity_fade')).toMatchObject({ status: 'missing', missingMetrics: ['cell.voltage.min'], reasons: [{ code: 'low_completeness', metricKey: 'batt.soc' }] });
    // 탱크: 뱅크 밸브(한정자 포인트)는 메트릭 키로 맞추고, 압축기·연료전지 설비가 없으면 그 메트릭은 누락
    expect(cellOf('H2BANK1/TANK1', 'tank.static_leak')).toMatchObject({ status: 'missing', missingMetrics: ['compressor.power', 'fc.h2.consumption'], recommendedMissing: ['h2.pressure'] });
  });

  it('dq.gap_flatline은 포인트가 있는 모든 설비에 적용, 형제 랙 포인트는 빌려 오지 않는다', () => {
    expect(cellOf('WX1', 'dq.gap_flatline').status).toBe('ready');
    expect(cellOf('H2BANK1', 'dq.gap_flatline').status).toBe('ready');
    expect(relatedPoints(SITE[6] as PipelineAsset, SITE, POINTS).every((p) => p.assetId === 7)).toBe(true);
    expect(relatedPoints(SITE[1] as PipelineAsset, SITE, POINTS).filter((p) => p.assetId === 4).map((p) => p.metricKey).sort()).toEqual(['ambient.temp', 'poa.irradiance']);
    expect(() => siteReadinessRows(SITE, POINTS, REQUIREMENTS, { minCompleteness: 2 })).toThrow(RangeError);
  });
});

describe('pointStatOf', () => {
  const NOW = Date.parse('2026-09-15T07:00:00Z');
  const DAY = 86_400_000;
  const base = { assetId: 1, metricKey: 'batt.soc', periodS: 60, firstMs: NOW - 120 * DAY, nGood: 30 * 1440 * 0.9, n: 30 * 1440, hours: 720 };

  it('완결성 = 창 good ÷ 기대(창 시작과 첫 데이터 중 늦은 시각부터), 이력은 내림 일수', () => {
    expect(pointStatOf(base, NOW, 30)).toEqual({ assetId: 1, metricKey: 'batt.soc', periodS: 60, completeness: 0.9, historyDays: 120 });
    // 10.5일 전에 생긴 포인트: 기대 샘플도 10.5일치 → 완결성 1, 이력 10일
    const young = pointStatOf({ ...base, firstMs: NOW - 10.5 * DAY, nGood: 10.5 * 1440, n: 10.5 * 1440, hours: 252 }, NOW, 30);
    expect(young).toMatchObject({ completeness: 1, historyDays: 10 });
  });

  it('창 샘플이 없으면 null, 주기가 없으면 샘플 밀도로 추정, 데이터도 없으면 0', () => {
    expect(pointStatOf({ ...base, nGood: 0, n: 0, hours: 0 }, NOW, 30).completeness).toBeNull();
    expect(pointStatOf({ ...base, periodS: null, n: 720 * 12, nGood: 720 * 12, hours: 720 }, NOW, 30)).toMatchObject({ periodS: 300, completeness: 1 });
    expect(pointStatOf({ ...base, periodS: null, firstMs: null, nGood: 0, n: 0, hours: 0 }, NOW, 30)).toEqual({ assetId: 1, metricKey: 'batt.soc', periodS: 0, completeness: null, historyDays: 0 });
  });
});

describe('셀 표시 규칙', () => {
  it('상태별 톤·아이콘·짧은 글자와 툴팁 문장(누락 메트릭·사유)', () => {
    expect(cellDisplay(cellOf('ESS1/RACK01', 'ess.capacity_fade'), '배터리 유효용량 감소')).toEqual({
      status: 'ready',
      tone: 'ok',
      icon: 'check',
      short: '준비',
      recommendedMissing: [],
      tooltip: 'ESS1/RACK01 · 배터리 유효용량 감소: 준비됨',
    });
    const missing = cellDisplay(cellOf('ESS1/RACK02', 'ess.capacity_fade'));
    expect(missing).toMatchObject({ tone: 'crit', icon: 'cross', short: '없음' });
    expect(missing.tooltip.split('\n')).toEqual(['ESS1/RACK02 · ess.capacity_fade: 필수 메트릭 없음', '누락 메트릭: cell.voltage.min', '사유: batt.soc 완결성 50% (기준 90% 이상)']);
    const partial = siteReadinessRows(SITE, [...POINTS.filter((p) => p.assetId !== 6), ...RACK.map((m) => stat(6, m, 300))], REQUIREMENTS)
      .find((r) => r.code === 'ESS1/RACK01')
      ?.cells.find((c) => c.detectorId === 'ess.cell_imbalance') as ReadinessCell;
    expect(cellDisplay(partial)).toMatchObject({ tone: 'warn', icon: 'alert', short: '부분' });
    expect(cellDisplay(cellOf('WX1', 'ess.capacity_fade'))).toMatchObject({ tone: 'na', icon: 'dash', short: '—', tooltip: expect.stringContaining('적용하지 않는') });
  });

  it('ready 비율 문구와 확보 순위 관련 탐지기', () => {
    expect(readyRatioText({ total: 4, applicable: 4, ready: 3, partial: 0, missing: 1, notApplicable: 0, readyRatio: 0.75 })).toBe('3 / 4 (75%)');
    expect(readyRatioText({ total: 2, applicable: 0, ready: 0, partial: 0, missing: 0, notApplicable: 2, readyRatio: null })).toBe('적용 셀 없음');
    const cells = ROWS.flatMap((r) => r.cells);
    const ranking = withRelatedDetectors(metricAcquisitionRanking(cells), cells);
    expect(ranking.find((r) => r.metricKey === 'heatsink.temp')).toMatchObject({ unlocks: 1, detectorIds: ['inv.thermal_derating'] });
    expect(ranking.find((r) => r.metricKey === 'fc.h2.consumption')?.detectorIds).toEqual(['h2chain.mass_balance_gap', 'tank.static_leak']);
  });
});
