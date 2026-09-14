import { describe, expect, it } from 'vitest';
import { actionProgress, parseExpectedEffect } from './progress';

const DAY = 86_400_000;
const PERFORMED = Date.UTC(2026, 7, 1);
const effect = { metric: 'ess.cell_dv_mv', direction: 'decrease', min_delta: 5, stabilization_days: 7 };

describe('actionProgress', () => {
  it('안정화 → after 창 → 창 채워짐 → 검증됨', () => {
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: effect, verdict: null }, PERFORMED - DAY)).toMatchObject({ state: 'stabilizing', label: '수행 예정 · 안정화 0/7일', fraction: 0 });
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: effect, verdict: null }, PERFORMED + 3.5 * DAY)).toMatchObject({ state: 'stabilizing', label: '안정화 3/7일' });
    const collecting = actionProgress({ performedAt: PERFORMED, expectedEffect: effect, verdict: null }, PERFORMED + 19 * DAY);
    expect(collecting).toMatchObject({ state: 'collecting', label: 'after 창 12/30일', afterStart: PERFORMED + 7 * DAY, afterEnd: PERFORMED + 37 * DAY });
    expect(collecting.fraction).toBeCloseTo(19 / 37, 5);
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: effect, verdict: null }, PERFORMED + 40 * DAY)).toMatchObject({ state: 'ready', label: '창 채워짐 · 분석 실행 필요', fraction: 1 });
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: effect, verdict: 'worse' }, PERFORMED + 40 * DAY)).toMatchObject({ state: 'verified', label: '악화', verdict: 'worse' });
  });

  it('기대 효과가 없거나 형식이 틀리면 검증 안 함, window_days가 있으면 그 길이', () => {
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: null, verdict: null }, PERFORMED)).toMatchObject({ state: 'untracked', label: '검증 안 함 (기대 효과 없음)' });
    expect(parseExpectedEffect({ ...effect, direction: 'up' })).toBeNull();
    expect(actionProgress({ performedAt: PERFORMED, expectedEffect: { ...effect, window_days: 14 }, verdict: null }, PERFORMED + 10 * DAY).label).toBe('after 창 3/14일');
  });
});

describe('검증 bin 표시', () => {
  it('지표별 bin 키를 조건 문장으로, 전후 bin을 키로 맞춘다', async () => {
    const { pairBins, verificationBinLabel } = await import('./bin-labels');
    expect(verificationBinLabel('ess.capacity_ah', '0.1|20')).toBe('0.10~0.15C · 20~25°C');
    expect(verificationBinLabel('ess.cell_dv_mv', 'all')).toBe('전체');
    expect(verificationBinLabel('el.v_cell_v', '1|60')).toMatch(/^1\.0~\d\.\d A\/cm² · 60~\d+°C$/);
    expect(pairBins('ess.cell_dv_mv', [{ key: 'all', n: 12, median: 30 }], [{ key: 'all', n: 11, median: 24 }])).toEqual([{ key: 'all', label: '전체', beforeN: 12, beforeMedian: 30, afterN: 11, afterMedian: 24 }]);
    expect(pairBins('fc.v_cell_v', [{ key: '60', n: 3, median: 0.7 }], []).map((p) => [p.label, p.afterN])).toEqual([['60~65°C', 0]]);
    expect(pairBins('ess.capacity_ah', [{ key: '0.15|20', n: 1, median: 1 }, { key: '0.1|20', n: 1, median: 1 }, { key: 'na|20', n: 1, median: 1 }], []).map((p) => p.key)).toEqual(['0.1|20', '0.15|20', 'na|20']);
  });
});
