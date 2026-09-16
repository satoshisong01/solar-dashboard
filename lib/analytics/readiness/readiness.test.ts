import { describe, expect, it } from 'vitest';
import { cellDisplay } from './display';
import { readinessCell, readinessMatrix, readinessSummary } from './matrix';
import { metricAcquisitionRanking } from './ranking';
import type { DetectorRequirement, ReadinessAsset, ReadinessCell, ReadinessPoint } from './types';

const point = (metricKey: string, periodS: number, completeness: number | null, historyDays: number): ReadinessPoint => ({ metricKey, periodS, completeness, historyDays });
const need = (key: string, maxPeriodS: number | null) => ({ key, maxPeriodS });
const nice = (key: string, maxPeriodS: number | null) => ({ key, maxPeriodS, optional: true }) as const;

const REQUIREMENTS: readonly DetectorRequirement[] = [
  // 주기 상한이 메트릭마다 다르다: 전류·SOC는 60초, 셀 온도는 조건 bin에만 쓰므로 300초
  { detectorId: 'ess.capacity_fade', failureMode: 'ess.capacity_fade', assetClass: ['ess.rack'], metrics: [need('batt.current', 60), need('batt.soc', 60), need('cell.temp.avg', 300)], minHistoryDays: 30, severity: 3 },
  { detectorId: 'ess.cell_imbalance', failureMode: 'ess.cell_imbalance', assetClass: ['ess.rack'], metrics: [need('batt.current', 60), need('cell.voltage.max', 60), need('cell.voltage.min', 60)], minHistoryDays: 14, severity: 2 },
  // op.state는 권장 메트릭이다 (없어도 판정, 판별 체크만 줄어든다)
  { detectorId: 'pv.inverter_peer', failureMode: 'pv.inverter_underperformance', assetClass: ['pv.inverter'], metrics: [need('ac.power', 300), need('ac.power.limit', 300), nice('op.state', 300)], minHistoryDays: 7, severity: 3 },
  { detectorId: 'inv.thermal_derating', failureMode: 'inv.thermal_derating', assetClass: ['pv.inverter'], metrics: [need('ac.power', 300), need('heatsink.temp', 300)], minHistoryDays: 30, severity: 2 },
  { detectorId: 'dq.gap_flatline', failureMode: 'dq.data_gap_flatline', assetClass: [], metrics: [], minHistoryDays: 1 },
];

const ASSETS: readonly ReadinessAsset[] = [
  { id: 5, code: 'WX1', classKey: 'wx.station', points: [] },
  {
    id: 1,
    code: 'ESS1/RACK01',
    classKey: 'ess.rack',
    points: [point('batt.current', 60, 0.99, 100), point('batt.soc', 60, 0.95, 100), point('cell.temp.avg', 60, 0.97, 100), point('cell.voltage.max', 60, 0.99, 100)],
  },
  {
    id: 2,
    code: 'ESS1/RACK02',
    classKey: 'ess.rack',
    points: [point('batt.current', 60, 0.8, 100), point('batt.soc', 300, 0.99, 100), point('cell.temp.avg', 60, 0.99, 20)],
  },
  // 셀 온도만 300초: 예전처럼 탐지기 하나에 한 상한을 걸면 '부분'이 되지만, 메트릭별 상한에서는 준비다
  { id: 6, code: 'ESS1/RACK03', classKey: 'ess.rack', points: [point('batt.current', 60, 0.99, 100), point('batt.soc', 60, 0.99, 100), point('cell.temp.avg', 300, 0.99, 100)] },
  { id: 3, code: 'PV1/INV01', classKey: 'pv.inverter', points: [point('ac.power', 60, 1, 200)] },
  { id: 4, code: 'PV1/INV02', classKey: 'pv.inverter', points: [point('ac.power', 60, 1, 200), point('ac.power.limit', 300, null, 200)] },
  // 권장 메트릭이 있지만 주기·완결성이 나쁘다 → 권장은 검사하지 않으므로 ready
  {
    id: 7,
    code: 'PV1/INV03',
    classKey: 'pv.inverter',
    points: [point('ac.power', 300, 0.99, 200), point('ac.power.limit', 300, 0.99, 200), point('heatsink.temp', 300, 0.99, 200), point('op.state', 3600, 0.1, 200)],
  },
  // 권장 메트릭만 없다 → ready + recommendedMissing
  { id: 8, code: 'PV1/INV04', classKey: 'pv.inverter', points: [point('ac.power', 300, 0.99, 200), point('ac.power.limit', 300, 0.99, 200), point('heatsink.temp', 300, 0.99, 200)] },
];

const cellOf = (cells: readonly ReadinessCell[], assetCode: string, detectorId: string): ReadinessCell => {
  const cell = cells.find((c) => c.assetCode === assetCode && c.detectorId === detectorId);
  if (!cell) throw new Error(`셀 없음: ${assetCode} ${detectorId}`);
  return cell;
};

describe('readinessMatrix 셀 상태 규칙', () => {
  const cells = readinessMatrix(ASSETS, REQUIREMENTS);

  it('설비 경로순 × 탐지기 입력 순서로 전체 셀을 만든다', () => {
    expect(cells).toHaveLength(ASSETS.length * REQUIREMENTS.length);
    expect([...new Set(cells.map((c) => c.assetCode))]).toEqual(['ESS1/RACK01', 'ESS1/RACK02', 'ESS1/RACK03', 'PV1/INV01', 'PV1/INV02', 'PV1/INV03', 'PV1/INV04', 'WX1']);
    expect(cells.slice(0, 5).map((c) => c.detectorId)).toEqual(REQUIREMENTS.map((r) => r.detectorId));
  });

  it('ready · n/a · missing(누락 메트릭 목록)', () => {
    expect(cellOf(cells, 'ESS1/RACK01', 'ess.capacity_fade')).toMatchObject({ status: 'ready', missingMetrics: [], recommendedMissing: [], reasons: [], severity: 3 });
    expect(cellOf(cells, 'ESS1/RACK01', 'pv.inverter_peer')).toMatchObject({ status: 'n/a', missingMetrics: [], recommendedMissing: [], reasons: [] });
    expect(cellOf(cells, 'ESS1/RACK01', 'ess.cell_imbalance')).toMatchObject({ status: 'missing', missingMetrics: ['cell.voltage.min'] });
    expect(cellOf(cells, 'PV1/INV01', 'inv.thermal_derating')).toMatchObject({ status: 'missing', missingMetrics: ['heatsink.temp'] });
  });

  it('주기 상한은 메트릭마다 본다: 같은 300초 포인트가 상한 60초 메트릭에서는 부분, 상한 300초 메트릭에서는 준비', () => {
    expect(cellOf(cells, 'ESS1/RACK03', 'ess.capacity_fade')).toMatchObject({ status: 'ready', reasons: [] });
    expect(cellOf(cells, 'ESS1/RACK02', 'ess.capacity_fade').reasons).toContainEqual({ code: 'coarse_period', metricKey: 'batt.soc', periodS: 300, requiredS: 60 });
    // 셀 온도는 두 랙 모두 사유가 없다 (RACK02는 60초, RACK03은 상한과 같은 300초)
    expect(cells.filter((c) => c.detectorId === 'ess.capacity_fade').flatMap((c) => c.reasons).filter((r) => 'metricKey' in r && r.metricKey === 'cell.temp.avg')).toEqual([]);
  });

  it('권장 메트릭: 없어도 ready이고 recommendedMissing에만 남는다. 있으면 주기·완결성을 보지 않는다', () => {
    expect(cellOf(cells, 'PV1/INV04', 'pv.inverter_peer')).toMatchObject({ status: 'ready', missingMetrics: [], recommendedMissing: ['op.state'], reasons: [] });
    expect(cellOf(cells, 'PV1/INV03', 'pv.inverter_peer')).toMatchObject({ status: 'ready', recommendedMissing: [], reasons: [] });
    // missing·partial 셀에도 권장 누락을 함께 남긴다
    expect(cellOf(cells, 'PV1/INV01', 'pv.inverter_peer')).toMatchObject({ status: 'missing', missingMetrics: ['ac.power.limit'], recommendedMissing: ['op.state'] });
    expect(cellOf(cells, 'PV1/INV02', 'pv.inverter_peer')).toMatchObject({ status: 'partial', recommendedMissing: ['op.state'] });
    // 툴팁은 상태와 따로 '권장 메트릭 없음'을 말한다
    expect(cellDisplay(cellOf(cells, 'PV1/INV04', 'pv.inverter_peer'), '인버터 동종 비교').tooltip).toBe(
      'PV1/INV04 · 인버터 동종 비교: 준비됨\n권장 메트릭 없음: op.state (없어도 판정은 하지만 판별 체크가 줄어듭니다)',
    );
  });

  it('partial: 완결성 < 0.9, 주기 > maxPeriodS, 이력 < minHistoryDays — 사유를 모두 남긴다', () => {
    expect(cellOf(cells, 'ESS1/RACK02', 'ess.capacity_fade')).toMatchObject({
      status: 'partial',
      reasons: [
        { code: 'low_completeness', metricKey: 'batt.current', completeness: 0.8, required: 0.9 },
        { code: 'coarse_period', metricKey: 'batt.soc', periodS: 300, requiredS: 60 },
        { code: 'short_history', historyDays: 20, requiredDays: 30 },
      ],
    });
    // 30일 샘플이 없는 포인트(completeness null)는 0으로 본다
    expect(cellOf(cells, 'PV1/INV02', 'pv.inverter_peer').reasons).toEqual([{ code: 'low_completeness', metricKey: 'ac.power.limit', completeness: null, required: 0.9 }]);
    // missing 셀에도 있는 메트릭의 부족 사유는 참고로 남긴다
    expect(cellOf(cells, 'ESS1/RACK02', 'ess.cell_imbalance')).toMatchObject({ status: 'missing', missingMetrics: ['cell.voltage.max', 'cell.voltage.min'], reasons: [{ code: 'low_completeness', metricKey: 'batt.current' }] });
  });

  it('요구 설비 종류가 비면 모든 설비에 적용, 필수 메트릭이 없으면 설비 포인트 최장 이력으로 판정', () => {
    expect(cells.filter((c) => c.detectorId === 'dq.gap_flatline').map((c) => [c.assetCode, c.status])).toEqual([
      ['ESS1/RACK01', 'ready'],
      ['ESS1/RACK02', 'ready'],
      ['ESS1/RACK03', 'ready'],
      ['PV1/INV01', 'ready'],
      ['PV1/INV02', 'ready'],
      ['PV1/INV03', 'ready'],
      ['PV1/INV04', 'ready'],
      ['WX1', 'partial'],
    ]);
    expect(cellOf(cells, 'WX1', 'dq.gap_flatline')).toMatchObject({ severity: 1, reasons: [{ code: 'short_history', historyDays: 0, requiredDays: 1 }] });
  });

  it('같은 메트릭 포인트가 여러 개면 완결성 → 주기 → 이력 순으로 가장 좋은 포인트를 쓴다', () => {
    const requirement = REQUIREMENTS[2] as DetectorRequirement;
    const qualified: ReadinessAsset = {
      id: 9,
      code: 'PV1/INV09',
      classKey: 'pv.inverter',
      points: [point('ac.power', 60, 0.5, 200), point('ac.power', 60, 0.95, 200), point('ac.power.limit', 600, 0.99, 200), point('ac.power.limit', 300, 0.99, 3), point('ac.power.limit', 300, 0.99, 200)],
    };
    expect(readinessCell(qualified, requirement)).toMatchObject({ status: 'ready', recommendedMissing: ['op.state'] });
  });

  it('minCompleteness 조정·범위 검사, 요약(ready 비율은 n/a 제외)', () => {
    expect(readinessMatrix(ASSETS, REQUIREMENTS, { minCompleteness: 0.75 }).find((c) => c.assetCode === 'ESS1/RACK02' && c.detectorId === 'ess.capacity_fade')?.reasons).toHaveLength(2);
    expect(() => readinessMatrix(ASSETS, REQUIREMENTS, { minCompleteness: 1.5 })).toThrow(RangeError);
    const summary = readinessSummary(cells);
    expect(summary).toEqual({ total: 40, applicable: 22, ready: 13, partial: 3, missing: 6, notApplicable: 18, readyRatio: 13 / 22 });
    expect(readinessSummary([]).readyRatio).toBeNull();
  });
});

describe('metricAcquisitionRanking 메트릭 확보 순위 (손계산)', () => {
  it('그 메트릭만 없어서 missing인 셀 수 내림차순, 동률은 심각도 합 → 관련 누락 셀 → 키 순. 권장 메트릭은 세지 않는다', () => {
    const ranking = metricAcquisitionRanking(readinessMatrix(ASSETS, REQUIREMENTS));
    expect(ranking).toEqual([
      // INV01·INV02 inv.thermal_derating(심각도 2) 둘 다 heatsink.temp만 없음
      { metricKey: 'heatsink.temp', unlocks: 2, severityWeight: 4, blockedCells: 2 },
      // INV01 pv.inverter_peer(심각도 3)
      { metricKey: 'ac.power.limit', unlocks: 1, severityWeight: 3, blockedCells: 1 },
      // RACK01 ess.cell_imbalance(심각도 2)만 풀림, RACK02·RACK03은 cell.voltage.max도 없어서 unlocks에 안 들어간다
      { metricKey: 'cell.voltage.min', unlocks: 1, severityWeight: 2, blockedCells: 3 },
      { metricKey: 'cell.voltage.max', unlocks: 0, severityWeight: 0, blockedCells: 2 },
    ]);
    // 권장 메트릭(op.state)은 벤더 확보 순위에 올리지 않는다 — 없어도 탐지기가 돌아간다
    expect(ranking.map((r) => r.metricKey)).not.toContain('op.state');
  });

  it('모든 기준이 같으면 메트릭 키 오름차순, missing이 없으면 빈 목록', () => {
    const base = { assetId: 1, assetCode: 'A', assetClass: 'x', failureMode: 'f', severity: 2, recommendedMissing: [], reasons: [] } as const;
    const cells: ReadinessCell[] = [
      { ...base, detectorId: 'd1', status: 'missing', missingMetrics: ['zeta'] },
      { ...base, detectorId: 'd2', status: 'missing', missingMetrics: ['alpha'] },
      { ...base, detectorId: 'd3', status: 'partial', missingMetrics: [] },
    ];
    expect(metricAcquisitionRanking(cells).map((r) => r.metricKey)).toEqual(['alpha', 'zeta']);
    expect(metricAcquisitionRanking([])).toEqual([]);
  });
});
