import { describe, expect, it } from 'vitest';
import { summarizePoints } from './dq-summary';
import { checkTransition, isFindingStatus, isOpenStatus, statusLabel } from './transition-rules';

describe('finding 상태 전이 규칙', () => {
  it('분류·리포트·조치·검증 흐름과 기각·재개', () => {
    expect(checkTransition('triage', 'new', 'a@x')).toEqual({ ok: true, to: 'triaged' });
    expect(checkTransition('report', 'triaged', 'a@x')).toEqual({ ok: true, to: 'in_report' });
    expect(checkTransition('action', 'in_report', 'a@x')).toEqual({ ok: true, to: 'action_taken' });
    expect(checkTransition('verify', 'action_taken', 'system')).toEqual({ ok: true, to: 'verified' });
    expect(checkTransition('dismiss', 'action_taken', 'a@x', '운영 조건 변경')).toEqual({ ok: true, to: 'dismissed' });
    expect(checkTransition('reopen', 'verified', 'a@x')).toEqual({ ok: true, to: 'reopened' });
    expect(checkTransition('worsen', 'in_report', 'system')).toEqual({ ok: true, to: 'reopened' });
  });

  it('verified·악화 재개는 system만, 관리자 동작은 system이 못 하고, 사유 없는 기각·잘못된 상태는 거절', () => {
    expect(checkTransition('verify', 'action_taken', 'a@x')).toMatchObject({ ok: false, reason: expect.stringContaining('시스템만') });
    expect(checkTransition('triage', 'new', 'system')).toMatchObject({ ok: false, reason: expect.stringContaining('관리자') });
    expect(checkTransition('dismiss', 'new', 'a@x', '   ')).toMatchObject({ ok: false, reason: '기각 사유를 입력하세요' });
    expect(checkTransition('triage', 'verified', 'a@x')).toMatchObject({ ok: false, reason: '효과 확인 상태에서는 분류됨(으)로 바꿀 수 없습니다' });
    expect(checkTransition('verify', 'triaged', 'system').ok).toBe(false);
  });

  it('상태 이름·열린 상태 판정', () => {
    expect(isFindingStatus('in_report')).toBe(true);
    expect(isFindingStatus('closed')).toBe(false);
    expect(isOpenStatus('reopened')).toBe(true);
    expect(isOpenStatus('dismissed')).toBe(false);
    expect(statusLabel('action_taken')).toBe('조치 완료');
  });
});

describe('데이터 품질 요약 (dq.gap_flatline 입력)', () => {
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 7, 1);
  const point = (pointId: number, periodS: number | null, flatlineMaxS: number | null = null) => ({ pointId, assetId: 10, metricKey: 'm', sourceKey: `S${pointId}`, periodS, flatlineMaxS });

  it('버킷이 없는 시간을 이어 결측 구간으로, 받은 샘플 수와 기대 샘플 수를 센다', () => {
    const hours = [0, 1, 4, 5].map((h) => ({ pointId: 1, hourStart: T0 + h * HOUR, n: 60 }));
    const flat = [{ pointId: 2, start: T0, end: T0 + 7 * HOUR, value: 21.5 }];
    const [first, second] = summarizePoints([point(1, 60), point(2, 300, 21_600), point(3, null)], hours, flat, { start: T0 - 10 * 60_000, end: T0 + 6 * HOUR });
    expect(first).toMatchObject({ pointId: 1, expectedSamples: 360, receivedSamples: 240, gaps: [{ start: T0 + 2 * HOUR, end: T0 + 4 * HOUR }], flatlines: [] });
    expect(second).toMatchObject({ expectedSamples: 72, receivedSamples: 0, gaps: [{ start: T0, end: T0 + 6 * HOUR }], flatlines: [{ start: T0, end: T0 + 7 * HOUR, value: 21.5 }] });
  });
});
