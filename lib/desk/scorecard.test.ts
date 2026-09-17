import { describe, expect, it } from 'vitest';
import { DETECTORS } from '@/lib/analytics/detectors';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { formatMagnitude, parseScorecard, trustBadgeFor } from './scorecard';
import { detectorStage, parseScorecardP3, pathLabel, seasonOf } from './scorecard-p3';

describe('parseScorecard (저장소의 scorecard.json)', () => {
  const scorecard = parseScorecard(scorecardJson);

  // 레지스트리에서 뽑아 견준다: 탐지기를 더하고 스코어카드를 갱신하지 않으면 여기서 깨진다
  it('레지스트리의 모든 탐지기를 덮고 게이트·곡선을 읽는다', () => {
    expect(scorecard.detectors.map((d) => d.detectorId).sort()).toEqual(DETECTORS.map((d) => d.id).sort());
    expect(scorecard.gates.length).toBeGreaterThan(0);
    expect(scorecard.pass).toBe(true);
    const capacity = scorecard.detectors[0];
    expect(capacity?.curve.map((p) => p.magnitude)).toEqual([1, 3, 5, 7, 10]);
    expect(scorecard.notEvaluated).toEqual([]);
    expect(trustBadgeFor(parseScorecard({ not_evaluated: { 'x.y': '평가 안 함' } }), 'x.y')).toEqual({ kind: 'none', note: '평가 안 함' });
  });

  it('신뢰 배지: 재현율·최소 탐지 크기·오탐률, 평가하지 않은 탐지기는 평가 결과 없음', () => {
    expect(trustBadgeFor(scorecard, 'ess.capacity_fade')).toMatchObject({ kind: 'evaluated', minDetectable: '3%', fpPerAssetMonth: 0 });
    expect(trustBadgeFor(scorecard, 'el.voltage_rise')).toMatchObject({ kind: 'evaluated', minDetectable: '10 µV/h' });
    expect(trustBadgeFor(scorecard, 'ess.cell_imbalance')).toMatchObject({ kind: 'evaluated', recall: 1, minDetectable: '5 mV/월', fpPerAssetMonth: 0 });
    expect(trustBadgeFor(scorecard, 'dq.gap_flatline')).toMatchObject({ kind: 'evaluated', minDetectable: '6 h', fpPerAssetMonth: 0 });
    expect(trustBadgeFor(scorecard, 'tank.static_leak')).toMatchObject({ kind: 'evaluated', minDetectable: '0.15 kg/일' });
    expect(trustBadgeFor(scorecard, 'pv.soiling_rate')).toMatchObject({ kind: 'evaluated', minDetectable: '0.05%/일', fpPerAssetMonth: 0.006 });
    expect(trustBadgeFor(scorecard, 'o2.purity_drift')).toMatchObject({ kind: 'evaluated', recall: 1, minDetectable: '0.4 vol%p' });
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

describe('parseScorecardP3 (P3 참고 지표)', () => {
  it('물질수지 잔차 분포·PV 대조군·경로 판별·누설 교차·냉각팬 지연을 읽는다', () => {
    const p3 = parseScorecardP3(scorecardJson);
    expect(p3.healthyMassBalance).toMatchObject({ days: 2190, medianPct: 0.101, p95Pct: 0.297 });
    expect(p3.pvControlFindings).toBe(0);
    expect(p3.elSecPathSupport?.byMode.map(([mode]) => pathLabel(mode))).toEqual(['정류기 효율 경로', '패러데이 효율 경로', '스택 전압 경로']);
    expect(p3.elSecPathSupport).toMatchObject({ overall: 0.722, target: 0.7 });
    expect(p3.tankLeakMassBalance).toEqual({ injections: 9, withFinding: 0, share: 0 });
    expect(p3.fanFailureDelays.map((row) => [row.startDay, row.startMs === null ? null : seasonOf(row.startMs)])).toEqual([
      [120, '겨울'],
      [200, '봄'],
      [280, '여름'],
    ]);
    expect(parseScorecardP3({})).toEqual({ healthyMassBalance: null, pvControlFindings: null, elSecPathSupport: null, tankLeakMassBalance: null, fanFailureDelays: [] });
  });

  it('탐지기 단계: P2 6종 외에는 P3', () => {
    expect(detectorStage('ess.capacity_fade')).toBe('P2');
    expect(detectorStage('tank.static_leak')).toBe('P3');
  });
});
