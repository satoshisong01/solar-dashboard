// 가평 3종 근거 파서: 탐지기가 실제로 내는 스냅샷(출력 계약)과 값이 없거나 타입이 틀린 스냅샷.
// 근거 화면(components/desk/p3/gapyeong-canvas.tsx)이 쓰는 detail이 채워지는지까지 본다.
import { describe, expect, it } from 'vitest';
import { hxFouling, o2PurityDrift, prvSeatLeak } from '@/lib/analytics/detectors';
import { GP_DAY0, htoDaysFixture, hxSamplesFixture, prvHoldsFixture } from '@/lib/analytics/detectors/gapyeong-fixtures';
import type { CandidateFinding, DetectorResult } from '@/lib/analytics/detectors/types';
import { MS_PER_DAY } from '@/lib/analytics/types';
import { createRng } from '@/lib/sim/rng';
import { parseGapyeongEvidence } from './gapyeong-evidence';
import type { GapyeongDetail, GapyeongEvidenceDetectorId } from './p3-evidence-types';

const DAYS = 45;
const NOW = GP_DAY0 + DAYS * MS_PER_DAY;
const ctx = { now: NOW, rng: createRng(1), params: {} };
const from = (day0: number, value: number) => (day: number) => (day >= day0 ? value : 0);

function only(result: DetectorResult): CandidateFinding {
  const finding = result.status === 'ok' ? result.findings[0] : undefined;
  if (!finding) throw new Error(`발견사항이 없습니다: ${result.status === 'ok' ? 'findings 0건' : result.reason}`);
  return finding;
}

const detailOf = <K extends GapyeongDetail['kind']>(snapshot: unknown, detectorId: GapyeongEvidenceDetectorId, kind: K): Extract<GapyeongDetail, { kind: K }> => {
  const detail = parseGapyeongEvidence(snapshot, detectorId).detail;
  if (detail.kind !== kind) throw new Error(`${kind} detail이 아닙니다: ${detail.kind}`);
  return detail as Extract<GapyeongDetail, { kind: K }>;
};

describe('prv.seat_leak', () => {
  const snapshot = () => only(prvSeatLeak.detect({ assetId: 70, outletSetBar: 0.8, downstreamVolumeM3: 0.5, holds: prvHoldsFixture({ seed: 31, holds: DAYS, creepBarPerH: from(30, 0.06) }) }, ctx)).evidence;

  it('구간 표·경고 기준·설정압을 mbar/h로 읽는다', () => {
    const detail = detailOf(snapshot(), 'prv.seat_leak', 'prv');
    expect(detail.setpointBar).toBe(0.8);
    expect(detail.warnMbarPerH).toBeCloseTo(13, 6); // 기본 0.013 bar/h
    expect(detail.alertMbarPerH).toBeCloseTo(130, 6);
    expect(detail.alarmHolds).toBeGreaterThanOrEqual(detail.minAlarmHolds);
    expect(detail.holds.length).toBeGreaterThan(0);
    const hold = detail.holds[0];
    expect(hold?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hold?.creepMbarPerH ?? 0).toBeGreaterThan(0);
    expect(hold?.endBar ?? 0).toBeGreaterThan(hold?.startBar ?? 0);
    expect(hold?.hours).toBeGreaterThan(0);
  });

  it('CI는 최근 구간 중앙값을 품는다', () => {
    const view = parseGapyeongEvidence(snapshot(), 'prv.seat_leak');
    const detail = detailOf(snapshot(), 'prv.seat_leak', 'prv');
    expect(detail.ciLowMbarPerH).not.toBeNull();
    expect(detail.ciLowMbarPerH ?? 0).toBeLessThanOrEqual(view.recentLevel ?? 0);
    expect(detail.ciHighMbarPerH ?? 0).toBeGreaterThanOrEqual(view.recentLevel ?? 0);
  });
});

describe('hx.fouling', () => {
  const snapshot = () => only(hxFouling.detect({ assetId: 63, designApproachK: 20, designUaKwK: 0.76, samples: hxSamplesFixture({ seed: 32, days: DAYS, fouling: from(DAYS - 7, 0.5) }) }, ctx)).evidence;

  it('비교 bin·설계값·UA·시간별 점을 읽는다', () => {
    const detail = detailOf(snapshot(), 'hx.fouling', 'hx');
    expect(detail.binWidthC).toBe(3);
    expect(detail.bins.length).toBeGreaterThan(0);
    expect(detail.minDeltaThetaK).toBe(10);
    expect(detail.designApproachK).toBe(20);
    expect(detail.designUaKwK).toBe(0.76);
    expect(detail.riseK ?? 0).toBeGreaterThan(0);
    expect(detail.points.length).toBeGreaterThan(0);
    expect(detail.points[0]?.hotInC).not.toBeNull();
    expect(detail.points[0]?.approachK).not.toBeNull();
  });

  it('접근온도 95% CI가 최근 대표값을 품는다', () => {
    const view = parseGapyeongEvidence(snapshot(), 'hx.fouling');
    const detail = detailOf(snapshot(), 'hx.fouling', 'hx');
    expect(detail.ciLowK ?? 0).toBeLessThanOrEqual(view.recentLevel ?? 0);
    expect(detail.ciHighK ?? 0).toBeGreaterThanOrEqual(view.recentLevel ?? 0);
  });
});

describe('o2.purity_drift', () => {
  const snapshot = () => only(o2PurityDrift.detect({ assetId: 80, days: htoDaysFixture({ seed: 33, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 1.3 : 0.6) }), calibrationTs: [] }, ctx)).evidence;

  it('법정 한계선·95퍼센타일·일별 값을 읽는다', () => {
    const view = parseGapyeongEvidence(snapshot(), 'o2.purity_drift');
    const detail = detailOf(snapshot(), 'o2.purity_drift', 'o2');
    expect(view.limit).toBe(2);
    expect(detail.lelPct).toBe(4);
    expect(detail.recentP95Pct ?? 0).toBeGreaterThan(0);
    expect(detail.days.length).toBeGreaterThan(0);
    expect(detail.days[0]?.medianPct).not.toBeNull();
    expect(detail.days[0]?.maxPct ?? 0).toBeGreaterThanOrEqual(detail.days[0]?.medianPct ?? 0);
  });

  it('여유는 (한계 − 최근값)이라 이미 넘었으면 음수로 온다', () => {
    const view = parseGapyeongEvidence(snapshot(), 'o2.purity_drift');
    expect(view.margin).toBeCloseTo((view.limit ?? 0) - (detailOf(snapshot(), 'o2.purity_drift', 'o2').recentP95Pct ?? 0), 3);
  });
});

describe('옛·손상 스냅샷', () => {
  it('빈 스냅샷에서도 던지지 않고 null·빈 배열·0으로 읽는다', () => {
    for (const [detectorId, kind] of [
      ['prv.seat_leak', 'prv'],
      ['hx.fouling', 'hx'],
      ['o2.purity_drift', 'o2'],
    ] as const) {
      const view = parseGapyeongEvidence({}, detectorId);
      expect(view.detail.kind).toBe(kind);
      expect(view.recentLevel).toBeNull();
      expect(view.points).toEqual([]);
      expect(view.checks).toEqual([]);
    }
  });

  it('타입이 틀린 값은 그 필드만 버리고 나머지를 읽는다', () => {
    const detail = detailOf({ threshold: { warn_bar_per_h: 'x' }, setpoint_bar: null, holds: [{ date: '2026-09-11', hours: 8, creep_bar_per_h: 0.07, start_bar: 1, end_bar: 1.5, settle_ratio: 0.9 }, { hours: 3 }, 7] }, 'prv.seat_leak', 'prv');
    expect(detail.warnMbarPerH).toBeNull();
    expect(detail.setpointBar).toBeNull();
    expect(detail.holds).toHaveLength(1);
    expect(detail.holds[0]?.creepMbarPerH).toBeCloseTo(70, 6);
  });

  it('접근온도 CI가 자기 대표값 밖이면(옛 계산) 쓰지 않는다', () => {
    const stale = { approach: { reference_k: 12.94, recent_k: 21.67, rise_k: 8.73, ci_low_k: 21.78, ci_high_k: 22.56 }, ua: null, points: [] };
    expect(detailOf(stale, 'hx.fouling', 'hx').ciLowK).toBeNull();
    const fixed = { ...stale, approach: { ...stale.approach, ci_low_k: 21.49, ci_high_k: 21.88 } };
    expect(detailOf(fixed, 'hx.fouling', 'hx').ciLowK).toBe(21.49);
  });

  it('근거 확장 이전 hx 스냅샷: 없는 필드는 null, 있는 값은 그대로', () => {
    const detail = detailOf({ approach: { reference_k: 12.9, recent_k: 21.7, rise_k: 8.7 }, ua: null, points: [] }, 'hx.fouling', 'hx');
    expect(detail.riseK).toBe(8.7);
    expect(detail.ciLowK).toBeNull();
    expect(detail.uaRecentKwK).toBeNull();
    expect(detail.bins).toEqual([]);
    expect(detail.points).toEqual([]);
  });
});
