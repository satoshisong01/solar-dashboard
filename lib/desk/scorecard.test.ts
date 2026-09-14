import { describe, expect, it } from 'vitest';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { formatMagnitude, parseScorecard, trustBadgeFor } from './scorecard';

describe('parseScorecard (저장소의 scorecard.json)', () => {
  const scorecard = parseScorecard(scorecardJson);

  it('탐지기 5종·게이트·곡선을 읽는다', () => {
    expect(scorecard.detectors.map((d) => d.detectorId)).toEqual(['ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay']);
    expect(scorecard.gates.length).toBeGreaterThan(0);
    expect(scorecard.pass).toBe(true);
    const capacity = scorecard.detectors[0];
    expect(capacity?.curve.map((p) => p.magnitude)).toEqual([1, 3, 5, 7, 10]);
    expect(scorecard.notEvaluated.map(([id]) => id)).toContain('dq.gap_flatline');
  });

  it('신뢰 배지: 재현율·최소 탐지 크기·오탐률, 평가하지 않은 탐지기는 평가 결과 없음', () => {
    expect(trustBadgeFor(scorecard, 'ess.capacity_fade')).toMatchObject({ kind: 'evaluated', minDetectable: '3%', fpPerAssetMonth: 0 });
    expect(trustBadgeFor(scorecard, 'el.voltage_rise')).toMatchObject({ kind: 'evaluated', minDetectable: '10 µV/h' });
    const imbalance = trustBadgeFor(scorecard, 'ess.cell_imbalance');
    expect(imbalance).toMatchObject({ kind: 'evaluated', recall: null, minDetectable: null, fpPerAssetMonth: 0 });
    const dq = trustBadgeFor(scorecard, 'dq.gap_flatline');
    expect(dq.kind).toBe('none');
    expect(dq.kind === 'none' && dq.note).toContain('DB E2E');
    expect(trustBadgeFor(parseScorecard({}), 'ess.capacity_fade')).toEqual({ kind: 'none', note: null });
  });
});

describe('formatMagnitude', () => {
  it('% 계열은 붙이고 나머지 단위는 띄운다', () => {
    expect(formatMagnitude(2, '%p')).toBe('2%p');
    expect(formatMagnitude(20, 'µV/h')).toBe('20 µV/h');
    expect(formatMagnitude(null, '%')).toBeNull();
    expect(formatMagnitude(1.5, null)).toBe('1.5');
  });
});
