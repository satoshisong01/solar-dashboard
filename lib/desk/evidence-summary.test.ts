import { describe, expect, it } from 'vitest';
import { parseEvidence } from './evidence';
import { evidenceConditionText } from './evidence-summary';

describe('evidenceConditionText', () => {
  it('용량 감소는 같은 조건 문장 (예전 스냅샷도 기본 bin 폭으로)', () => {
    const view = parseEvidence({ method: 'matched_ratio', metric: 'capacity_ah_anchored', bins: [{ key: '0.2|20', n_ref: 18, n_cur: 9, used: true }] });
    expect(evidenceConditionText(view)).toBe('충전전류 0.20~0.25C, 셀온도 20~25°C, 휴지 후 SOC ≤ 20% 시작 → 완충, 기준 18회·최근 9회');
  });

  it('스택: 구간 수·break-in·bin 수', () => {
    const view = parseEvidence({ method: 'binned_residual_theil_sen', break_in_hours: 1000, excluded_break_in: 12, bins: [{ key: '0.6|55', n: 30 }, { key: '0.7|55', n: 20 }], trend: { points: [] } });
    expect(evidenceConditionText(view)).toBe('정상운전 50구간, break-in 1,000 h 이후 (이전 12구간 제외), 같은 전류밀도·온도 구간 2개로 맞춘 누적 운전시간 축 추세');
  });

  it('셀 불균형·인버터 동종·데이터 품질·모르는 형식', () => {
    expect(evidenceConditionText(parseEvidence({ method: 'median_shift_trend_peer', source: 'charge_end', reference: { n: 20 }, recent: { n: 25 }, peers: { values_mv: [{ asset_id: 2, dv_mv: 10 }] } }))).toBe(
      '충전 종료 셀 전압 편차(최고−최저), 기준 20회·최근 25회, 동종 랙 1대 비교',
    );
    expect(evidenceConditionText(parseEvidence({ method: 'peer_modified_z', excluded_days: 1, days: [{ day: '2026-09-10', peers: 4, flagged: true }, { day: '2026-09-11', peers: 3, flagged: false }] }))).toBe(
      '같은 사이트 동종 인버터 4대(자신 포함) 일 kWh/kWp 비교, 평가 2일 중 1일 낮음, 출력제한·클리핑·정지일 1일 제외',
    );
    expect(evidenceConditionText(parseEvidence({ method: 'gap_flatline_summary', gap_points: 1, flatline_points: 0, points: [{ point_id: 3 }] }))).toBe('포인트 1개 요약 (결측 1개 · 고착 0개)');
    expect(evidenceConditionText(parseEvidence({}))).toBeNull();
  });
});
