import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../detectors';
import { readinessCell } from './matrix';
import { requirementsFromDetectors } from './registry';

describe('레지스트리 → 준비도 요구 조건', () => {
  const requirements = requirementsFromDetectors(DETECTORS);

  it('탐지기 14종의 id·고장모드·requires를 그대로 옮기고 심각도는 카테고리로 정한다', () => {
    expect(requirements).toHaveLength(14);
    requirements.forEach((req, i) => {
      const detector = DETECTORS[i];
      expect(req).toMatchObject({ detectorId: detector?.id, failureMode: detector?.failureMode, metrics: detector?.requires.metrics, minHistoryDays: detector?.requires.minHistoryDays });
    });
    expect(requirements.find((r) => r.detectorId === 'tank.static_leak')?.severity).toBe(4);
    expect(requirements.find((r) => r.detectorId === 'dq.gap_flatline')).toMatchObject({ severity: 2, minPeriodS: null, assetClass: [] });
    expect(requirements.find((r) => r.detectorId === 'el.sec_rise')?.severity).toBe(3);
  });

  it('주기 상한이 null이면 포인트 주기가 길어도 partial로 만들지 않는다', () => {
    const dq = requirements.find((r) => r.detectorId === 'dq.gap_flatline');
    const asset = { id: 1, code: 'WX1', classKey: 'wx.station', points: [{ metricKey: 'poa.irradiance', periodS: 3_600, completeness: 1, historyDays: 30 }] };
    expect(dq && readinessCell(asset, dq).status).toBe('ready');
    const soiling = requirements.find((r) => r.detectorId === 'pv.soiling_rate');
    expect(soiling && readinessCell(asset, soiling).status).toBe('missing');
  });
});
