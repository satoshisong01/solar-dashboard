import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';

const T0 = Date.parse('2026-09-14T17:40:00Z');
const MIN = 60_000;

describe('buildTimeline', () => {
  it('전이·근거·조치·검증을 시간 역순으로 합치고, 같은 시각이면 검증 → 조치 → 전이 → 근거', () => {
    const entries = buildTimeline(
      {
        transitions: [
          { id: '1', fromStatus: null, toStatus: 'new', actor: 'system', note: '분석 실행 1', atMs: T0 },
          { id: '2', fromStatus: 'new', toStatus: 'action_taken', actor: 'admin@hysol.local', note: '조치 기록: 셀 밸런싱', atMs: T0 + 10 * MIN },
        ],
        evidences: [{ id: '5', runId: '1', inputHash: '4e6ce4ec7e9433fc', computedAtMs: T0 }],
        actions: [{ id: '9', actionType: '셀 밸런싱', performedAtMs: T0 + 3 * 86_400_000, performedBy: null, notes: '완충 유지', createdBy: 'admin@hysol.local', createdAtMs: T0 + 10 * MIN, expectedEffectText: '셀 편차 5 mV 이상 감소' }],
        verifications: [{ id: '3', actionId: '9', verdict: 'improved', effect: -6.25, ciLow: -8, ciHigh: -4.5, unit: 'mV', computedAtMs: T0 + 40 * 86_400_000 }],
      },
      T0 + 20 * MIN,
    );
    expect(entries.map((e) => e.key)).toEqual(['v3', 'a9', 't2', 't1', 'e5']);
    expect(entries[0]).toMatchObject({ title: '조치 효과 검증: 개선 확인', detail: '효과 −6.25 mV (95% CI −8 ~ −4.5)', actor: '시스템' });
    expect(entries[1]?.detail).toBe('수행 예정 2026-09-18 · 셀 편차 5 mV 이상 감소 · 완충 유지');
    expect(entries[2]).toMatchObject({ title: '상태 새 발견 → 조치 완료', actor: 'admin@hysol.local' });
    expect(entries[3]).toMatchObject({ title: '발견사항 생성 (새 발견)', actor: '시스템' });
    expect(entries[4]?.detail).toBe('분석 실행 #1 · 입력 해시 4e6ce4ec');
  });

  it('지난 수행일은 "수행", 판정 불가 검증은 효과 없이', () => {
    const entries = buildTimeline(
      {
        transitions: [],
        evidences: [],
        actions: [{ id: '1', actionType: '용량시험', performedAtMs: T0 - 86_400_000, performedBy: '현장팀', notes: null, createdBy: 'a@b.c', createdAtMs: T0, expectedEffectText: null }],
        verifications: [{ id: '2', actionId: '1', verdict: 'insufficient_data', effect: null, ciLow: null, ciHigh: null, unit: null, computedAtMs: T0 + MIN }],
      },
      T0,
    );
    expect(entries.map((e) => [e.title, e.detail])).toEqual([
      ['조치 효과 검증: 데이터 부족', null],
      ['조치 기록: 용량시험', '수행 2026-09-14 · 현장팀'],
    ]);
  });
});
