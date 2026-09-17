import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { EssChargeEpisode, EssRestEpisode } from '../episodes/ess';
import { MS_PER_DAY, MS_PER_HOUR } from '../types';
import { cellDvPoints, dqGapFlatline, essCellImbalance, pvInverterPeer, type CellDvPoint, type DqPointSummary } from './index';
import { chargeSession, DAY0, pvDay } from './test-fixtures';

const ctxAt = (now: number, seed = 1, params = {}) => ({ now, rng: createRng(seed), params });

describe('ess.cell_imbalance@1', () => {
  const NOW = DAY0 + 90 * MS_PER_DAY;
  const history = (endMv: number, seed: number): CellDvPoint[] => {
    const rng = createRng(seed);
    return Array.from({ length: 90 }, (_, day) => ({
      ts: DAY0 + day * MS_PER_DAY,
      dvMv: (day < 30 ? 10 : 10 + ((endMv - 10) * (day - 30)) / 60) + 0.5 * rng.gaussian(),
      source: 'charge_end' as const,
      completeness: 1,
    }));
  };
  const peers = [
    { assetId: 2, recentDvMv: 10 },
    { assetId: 3, recentDvMv: 11 },
    { assetId: 4, recentDvMv: 10.5 },
  ];

  it('기준 대비 +20 mV 이상 & 2개월 증가 추세면 finding, 동종 대비 z가 크면 severity 3', () => {
    const result = essCellImbalance.detect({ assetId: 1, points: history(45, 3), peers }, ctxAt(NOW));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'ess.cell_imbalance', severity: 3, category: 'degradation', effect: { unit: 'mV', levelUnit: 'mV' } });
    expect(finding?.effect.value).toBeGreaterThan(20);
    expect(finding?.summary).toContain('mV/월');
    expect(finding?.summary).toContain('수정 z');
  });

  it('동종이 부족하면 z 없이 severity 2, 편차가 그대로면 0건, 세션이 부족하면 insufficient', () => {
    const noPeers = essCellImbalance.detect({ assetId: 1, points: history(40, 4), peers: [] }, ctxAt(NOW));
    expect(noPeers.status === 'ok' && noPeers.findings[0]?.severity).toBe(2);
    expect(essCellImbalance.detect({ assetId: 1, points: history(10, 5), peers }, ctxAt(NOW))).toEqual({ status: 'ok', findings: [] });
    expect(essCellImbalance.detect({ assetId: 1, points: history(45, 6).slice(0, 10), peers }, ctxAt(NOW)).status).toBe('insufficient');
  });

  it('cellDvPoints는 유효한 충전·휴지 에피소드만 쓴다', () => {
    const charge = chargeSession({ day: 1, capacityAh: 400, dvMv: 12 });
    const rest = { ...charge, kind: 'ess.rest', features: { duration_s: 600, soc_mean: 50, t_cell_mean: 25, cell_dv_end: 4, v_end: 830 }, conditions: { t_cell_bin: 25, end_reason: 'rest' } } as unknown as EssRestEpisode;
    const invalid: EssChargeEpisode = { ...charge, valid: false, invalidReason: 'open' };
    expect(cellDvPoints([charge, invalid], [rest]).map((p) => [p.source, p.dvMv])).toEqual([
      ['charge_end', 12],
      ['rest', 4],
    ]);
  });
});

describe('pv.inverter_peer@1', () => {
  const NOW = DAY0 + 8 * MS_PER_DAY;
  const site = (lowPct: number, inverters = 4) =>
    Array.from({ length: 8 }, (_, day) =>
      Array.from({ length: inverters }, (_, i) => {
        const base = 4 * (1 + 0.002 * Math.sin(day + i));
        return pvDay(i + 1, day, i === inverters - 1 ? base * (1 + lowPct / 100) : base, day === 3 ? { curtailed: true } : {});
      }),
    ).flat();

  it('최근 7일 중 5일 이상 동종 대비 −6%면 효과 −6% ± 1%p, 제외일은 세지 않는다', () => {
    const result = pvInverterPeer.detect({ siteId: 1, days: site(-6) }, ctxAt(NOW));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ assetId: 4, severity: 2, failureMode: 'pv.inverter_underperformance', category: 'performance' });
    expect(finding?.effect.value).toBeGreaterThan(-7);
    expect(finding?.effect.value).toBeLessThan(-5);
    expect(finding?.summary).toContain('정지일 1일은 제외');
    expect((finding?.evidence.days as unknown[]).length).toBe(6);
  });

  it('MAD 하한(동종 중앙값 0.3%) 기준으로 −2% 저하는 잡고 −1% 저하는 넘기지 않는다', () => {
    const two = pvInverterPeer.detect({ siteId: 1, days: site(-2) }, ctxAt(NOW));
    expect(two.status === 'ok' && two.findings.map((f) => f.assetId)).toEqual([4]);
    expect(pvInverterPeer.detect({ siteId: 1, days: site(-1) }, ctxAt(NOW))).toEqual({ status: 'ok', findings: [] });
  });

  it('대조군은 0건, 큰 저하는 severity 3, 동종 3대 미만이면 insufficient', () => {
    expect(pvInverterPeer.detect({ siteId: 1, days: site(0) }, ctxAt(NOW))).toEqual({ status: 'ok', findings: [] });
    const big = pvInverterPeer.detect({ siteId: 1, days: site(-15) }, ctxAt(NOW));
    expect(big.status === 'ok' && big.findings[0]?.severity).toBe(3);
    expect(pvInverterPeer.detect({ siteId: 1, days: site(-6, 2) }, ctxAt(NOW)).status).toBe('insufficient');
  });
});

describe('dq.gap_flatline@1', () => {
  const window = { start: DAY0, end: DAY0 + 7 * MS_PER_DAY };
  const point = (overrides: Partial<DqPointSummary>): DqPointSummary => ({
    pointId: 1,
    assetId: 10,
    metricKey: 'batt.soc',
    sourceKey: 'ESS1/RACK01/SOC',
    expectedSamples: 10_080,
    receivedSamples: 10_080,
    gaps: [],
    flatlines: [],
    ...overrides,
  });

  it('결측·고착이 있으면 설비별 severity 2 데이터 품질 finding과 점검 권고', () => {
    const points = [
      point({ receivedSamples: 9_720, gaps: [{ start: DAY0 + MS_PER_DAY, end: DAY0 + MS_PER_DAY + 6 * MS_PER_HOUR }] }),
      point({ pointId: 2, metricKey: 'cell.temp.avg', sourceKey: 'ESS1/RACK01/T_CELL_AVG', flatlines: [{ start: DAY0, end: DAY0 + 8 * MS_PER_HOUR, value: 24.5 }] }),
      point({ pointId: 3, assetId: 11, sourceKey: 'PV1/INV01/P_AC' }),
    ];
    const result = dqGapFlatline.detect({ siteId: 1, window, points }, ctxAt(window.end));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ assetId: 10, severity: 2, category: 'data_quality', failureMode: 'dq.data_gap_flatline', title: '데이터 품질: 수신 결측·센서 값 고착' });
    // 효과는 완결성 수준이 아니라 기준(100%) 대비 변화량이다 — 수준을 넣으면 화면 칩이 '+91.7%'로 오른 것처럼 보인다
    expect(finding?.effect).toMatchObject({ metric: 'dq.completeness', unit: '%p', baseline: 100 });
    expect(finding?.effect.value).toBeLessThan(0);
    expect(finding?.effect.value).toBeCloseTo((finding?.effect.current ?? 0) - 100, 2);
    expect(finding?.summary).toContain('게이트웨이·통신 경로 점검과 센서 교정·배선 점검을 권고합니다.');
    expect(finding?.summary).toContain('ESS1/RACK01/T_CELL_AVG');
  });

  it('고착만 있으면 고착 시간이 효과, 문제가 없으면 0건, 포인트가 없으면 insufficient', () => {
    const flatOnly = dqGapFlatline.detect({ siteId: 1, window, points: [point({ flatlines: [{ start: DAY0, end: DAY0 + 7 * MS_PER_HOUR, value: 1 }] })] }, ctxAt(window.end));
    expect(flatOnly.status === 'ok' && flatOnly.findings[0]?.effect).toMatchObject({ metric: 'dq.flatline_hours', value: 7, unit: 'h' });
    expect(dqGapFlatline.detect({ siteId: 1, window, points: [point({})] }, ctxAt(window.end))).toEqual({ status: 'ok', findings: [] });
    expect(dqGapFlatline.detect({ siteId: 1, window, points: [] }, ctxAt(window.end)).status).toBe('insufficient');
  });
});
