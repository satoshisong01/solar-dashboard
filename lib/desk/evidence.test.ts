// 계약 테스트: 탐지기가 만든 근거 스냅샷을 분석 데스크 표시 모델로 읽을 수 있는지 (탐지기 형식이 바뀌면 여기서 깨진다).
import { describe, expect, it } from 'vitest';
import { essCapacityFade } from '@/lib/analytics/detectors/ess-capacity-fade';
import { essCellImbalance } from '@/lib/analytics/detectors/ess-cell-imbalance';
import { elVoltageRise } from '@/lib/analytics/detectors/stack-detectors';
import { capacityHistory, DAY0, elRuns } from '@/lib/analytics/detectors/test-fixtures';
import type { CandidateFinding, DetectorResult } from '@/lib/analytics/detectors/types';
import { MS_PER_DAY } from '@/lib/analytics/types';
import { createRng } from '@/lib/sim/rng';
import { capacityConditionSentence } from './conditions';
import { parseChecks, parseEvidence } from './evidence';

const firstFinding = (result: DetectorResult): CandidateFinding => {
  if (result.status !== 'ok' || !result.findings[0]) throw new Error('탐지 결과가 없습니다');
  return result.findings[0];
};

describe('parseEvidence', () => {
  it('ess.capacity_fade: bin·bin 폭·추세·오버레이·체크를 읽고 조건 문장을 만든다', () => {
    const sessions = capacityHistory(400, 375, 11);
    const curves = sessions.map((s) => ({ start: s.start, points: [{ elapsed_s: 0, ah: 0, soc: 10 }, { elapsed_s: 28_800, ah: s.features.ah_in, soc: 100 }] }));
    const finding = firstFinding(
      essCapacityFade.detect(
        { assetId: 7, ratedCapacityAh: 400, commissionedAt: DAY0 - MS_PER_DAY, sessions, events: [], curves },
        { now: DAY0 + 90 * MS_PER_DAY, rng: createRng(1), params: { cRateBinWidth: 0.05, tempBinWidthC: 5 } },
      ),
    );
    const view = parseEvidence(finding.evidence);
    if (view.kind !== 'capacity') throw new Error(`capacity가 아닙니다: ${view.kind}`);
    expect(view.metric).toBe('capacity_ah_anchored');
    expect(view.widths).toEqual({ cRate: 0.05, tempC: 5 });
    expect(view.bins.filter((b) => b.used).length).toBeGreaterThan(0);
    expect(view.trend?.points.length).toBeGreaterThan(10);
    expect(view.trend?.line).toHaveLength(2);
    expect(view.trend?.slope).toBeLessThan(0);
    expect(view.trend?.slopeText).toMatch(/^−\d+\.\d{2} %p\/월 \(95% CI/);
    expect(view.sohTarget?.pct).toBe(80);
    expect(view.referenceCurrentA).toBeCloseTo(50, 0);
    expect(view.overlay.reference?.points.length).toBe(2);
    expect(view.overlay.recent?.points[1]?.soc).toBe(100);
    expect(view.checks).toHaveLength(5);
    expect(view.checks[0]?.measured[0]?.[0]).toBe('기준 셀온도 (°C)');
    expect(capacityConditionSentence({ metric: view.metric, bins: view.bins, widths: view.widths, rules: view.rules })).toMatch(
      /^충전전류 0\.10~0\.20C, 셀온도 20~30°C, 휴지 후 SOC ≤ 20% 시작 → 완충, 기준 \d+회·최근 \d+회$/,
    );
  });

  it('bin 폭이 없는 예전 스냅샷은 탐지기 기본값으로 채운다', () => {
    const view = parseEvidence({ method: 'matched_ratio', metric: 'capacity_ah_soc', bins: [{ key: '0.1|20', n_ref: 3, n_cur: 3, used: true }] });
    expect(view.kind === 'capacity' && view.widths).toEqual({ cRate: 0.05, tempC: 5 });
    expect(view.kind === 'capacity' && view.overlay).toEqual({ reference: null, recent: null });
  });

  it('el.voltage_rise: 운전시간 축 추세(mV/h)와 bin 라벨', () => {
    const finding = firstFinding(elVoltageRise.detect({ assetId: 31, episodes: elRuns({ count: 400, startHours: 1200, endHours: 2400, rateUvPerH: 25, seed: 2 }) }, { now: DAY0 + 400 * MS_PER_DAY, rng: createRng(1), params: {} }));
    const view = parseEvidence(finding.evidence);
    if (view.kind !== 'stack') throw new Error(`stack이 아닙니다: ${view.kind}`);
    expect(view.trend?.xKind).toBe('op_hours');
    expect(view.trend?.slope).toBeCloseTo((finding.effect.value ?? 0) / 1000, 3);
    expect(view.trend?.slopeText).toMatch(/µV\/h \(95% CI/);
    expect(view.breakInHours).toBe(1000);
    expect(view.bins[0]?.label).toMatch(/A\/cm² · \d+~\d+ °C$/);
    expect(view.checks.map((c) => c.id)).toContain('stack_temperature_shift');
  });

  it('ess.cell_imbalance: 추세선 두 점과 동종 값', () => {
    const now = DAY0 + 90 * MS_PER_DAY;
    const rng = createRng(3);
    const points = Array.from({ length: 90 }, (_, day) => ({ ts: DAY0 + day * MS_PER_DAY, dvMv: (day < 30 ? 10 : 10 + (35 * (day - 30)) / 60) + 0.5 * rng.gaussian(), source: 'charge_end' as const, completeness: 1 }));
    const finding = firstFinding(essCellImbalance.detect({ assetId: 1, points, peers: [{ assetId: 2, recentDvMv: 10 }, { assetId: 3, recentDvMv: 11 }] }, { now, rng: createRng(1), params: {} }));
    const view = parseEvidence(finding.evidence);
    if (view.kind !== 'cell_imbalance') throw new Error(`cell_imbalance가 아닙니다: ${view.kind}`);
    expect(view.trend?.line).toHaveLength(2);
    const [start, end] = view.trend?.line ?? [];
    expect((end?.[1] ?? 0) - (start?.[1] ?? 0)).toBeGreaterThan(20);
    expect(view.peers.values).toEqual([{ assetId: 2, dvMv: 10 }, { assetId: 3, dvMv: 11 }]);
  });

  it('모르는 method나 형식이 깨진 값은 unknown·빈 목록으로 읽는다', () => {
    expect(parseEvidence({ method: 'future_method' })).toEqual({ kind: 'unknown' });
    expect(parseEvidence(null)).toEqual({ kind: 'unknown' });
    expect(parseChecks([{ id: 'x', status: 'maybe' }, { id: 'y', status: 'supports', measured: { t_ref_c: 20, nested: { a: 1 } } }])).toEqual([
      { id: 'y', label: 'y', status: 'supports', measured: [['기준 셀온도 (°C)', 20], ['nested', null]], note: '' },
    ]);
  });
});
