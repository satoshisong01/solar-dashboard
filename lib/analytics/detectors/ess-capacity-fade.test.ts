import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { MS_PER_DAY } from '../types';
import { capacityChecks, ESS_CAPACITY_DEFAULTS } from './index';
import { essCapacityFade, type EssCapacityInput } from './ess-capacity-fade';
import { capacityHistory, chargeSession, DAY0 } from './test-fixtures';
import type { DetectorContext, EssCapacityParams } from './index';

const NOW = DAY0 + 90 * MS_PER_DAY;
const ctx = (seed = 1, extra: Partial<DetectorContext<EssCapacityParams>> = {}): DetectorContext<EssCapacityParams> => ({ now: NOW, rng: createRng(seed), params: {}, ...extra });
const input = (sessions: EssCapacityInput['sessions'], extra: Partial<EssCapacityInput> = {}): EssCapacityInput => ({
  assetId: 7,
  ratedCapacityAh: 400,
  commissionedAt: DAY0 - MS_PER_DAY,
  sessions,
  events: [],
  ...extra,
});

describe('ess.capacity_fade@1', () => {
  it('용량 −6.25% 주입(400 → 375 Ah)을 −6.25% ± 1%p로 추정하고 severity 3', () => {
    const result = essCapacityFade.detect(input(capacityHistory(400, 375, 11)), ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding?.effect.value).toBeGreaterThan(-7.25);
    expect(finding?.effect.value).toBeLessThan(-5.25);
    expect(finding?.effect.ciHigh).toBeLessThan(0);
    expect(finding?.effect).toMatchObject({ metric: 'capacity_ah_anchored', unit: '%', levelUnit: 'Ah' });
    expect(finding?.effect.baseline).toBeCloseTo(400, -1);
    expect(finding).toMatchObject({ detectorId: 'ess.capacity_fade', detectorVersion: '1', assetId: 7, failureMode: 'ess.capacity_fade', category: 'degradation', severity: 3 });
    expect(finding?.confidence).toBeGreaterThan(0.5);
    expect(finding?.title).toContain('유효용량');
    expect(finding?.summary).toMatch(/같은 조건 충전 30회 비교: 유효용량 \d{3} Ah → 3\d\d Ah\(-[567]\.\d%, 95% CI -\d\.\d ~ -\d\.\d%\)/);
    expect(finding?.summary).toMatch(/50 A 기준 충전시간 약 [78]시간 \d+분 → 7시간 \d+분\./);
    expect(finding?.inputHash).toMatch(/^[0-9a-f]{32}$/);

    const evidence = finding?.evidence as Record<string, unknown>;
    expect((evidence.checks as unknown[]).length).toBe(5);
    expect((evidence.bins as unknown[]).length).toBe(4);
    const trend = evidence.trend as Record<string, number | null>;
    expect(trend.slope_pct_per_month).toBeLessThan(0);
    expect(JSON.stringify(evidence).length).toBeLessThan(20_000);
  });

  it('대조군(용량 변화 없음)은 finding 0건', () => {
    const result = essCapacityFade.detect(input(capacityHistory(400, 400, 12)), ctx());
    expect(result).toEqual({ status: 'ok', findings: [] });
  });

  it('결정성: 같은 시드 → 같은 결과', () => {
    const sessions = capacityHistory(400, 370, 13);
    expect(essCapacityFade.detect(input(sessions), ctx(5))).toEqual(essCapacityFade.detect(input(sessions), ctx(5)));
  });

  it('앵커 세션이 모자라면 CC 구간 Ah 보조 지표로 비교하고, 끄면 insufficient', () => {
    const sessions = capacityHistory(400, 350, 14, { anchored: false });
    const fallback = essCapacityFade.detect(input(sessions), ctx());
    expect(fallback.status).toBe('ok');
    if (fallback.status === 'ok') {
      expect(fallback.findings[0]?.effect.metric).toBe('capacity_ah_cc');
      expect(fallback.findings[0]?.severity).toBe(4);
      expect(fallback.findings[0]?.summary).toContain('보조 지표');
    }
    const strict = essCapacityFade.detect(input(sessions), ctx(1, { params: { useCcAhFallback: false } }));
    expect(strict.status).toBe('insufficient');
  });

  it('세션이 부족하거나 정격이 없으면 insufficient와 이유', () => {
    const few = essCapacityFade.detect(input(capacityHistory(400, 375, 15).slice(0, 25)), ctx());
    expect(few).toMatchObject({ status: 'insufficient' });
    if (few.status === 'insufficient') expect(few.reason).toContain('세션 부족');
    expect(essCapacityFade.detect(input([], { ratedCapacityAh: 0 }), ctx()).status).toBe('insufficient');
  });

  it('기준선 재설정(resets_baseline) 이후 데이터만 쓰므로 그 전의 감소는 사라진다', () => {
    const sessions = capacityHistory(400, 375, 16);
    const reset = essCapacityFade.detect(input(sessions, { events: [{ ts: DAY0 + 55 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: true }] }), ctx());
    expect(reset.status).toBe('insufficient');
    const byContext = essCapacityFade.detect(input(sessions), ctx(1, { baselineResetAt: DAY0 + 55 * MS_PER_DAY }));
    expect(byContext.status).toBe('insufficient');
  });

  it('detector_config 기준 창을 쓰고 대표 세션 충전 곡선을 오버레이에 넣는다', () => {
    const sessions = capacityHistory(400, 375, 17);
    const curves = sessions.map((s) => ({ start: s.start, points: [{ elapsed_s: 0, ah: 0, soc: 10 }, { elapsed_s: 28_800, ah: s.features.ah_in, soc: 100 }] }));
    const result = essCapacityFade.detect(input(sessions, { curves }), ctx(1, { referenceWindow: { start: DAY0, end: DAY0 + 20 * MS_PER_DAY } }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const overlay = (result.findings[0]?.evidence as Record<string, Record<string, unknown>>).overlay;
    expect(overlay?.reference).not.toBeNull();
    expect(overlay?.recent).not.toBeNull();
  });
});

describe('capacityChecks', () => {
  const p = ESS_CAPACITY_DEFAULTS;
  const refs = Array.from({ length: 6 }, (_, i) => chargeSession({ day: i, capacityAh: 400, tCell: 25, ccAh: 340, cvS: 900, dvMv: 8 }));

  it('저온·설정 변경·내부저항·셀 불균형·BMS 재보정을 지지로 판정한다', () => {
    const recent = Array.from({ length: 6 }, (_, i) => {
      const base = chargeSession({ day: 60 + i, capacityAh: 375, tCell: 20, ccAh: 320, cvS: 1200, dvMv: 25, socEnd: 96 });
      return { ...base, features: { ...base.features, soc_start: 18 } };
    });
    const events = [
      { ts: DAY0 + 30 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: false },
      { ts: DAY0 + 31 * MS_PER_DAY, kind: 'firmware', resetsBaseline: false },
    ] as const;
    const checks = capacityChecks(refs, recent, events, DAY0 + 10 * MS_PER_DAY, p);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['cold', 'supports'],
      ['soc_setpoint', 'supports'],
      ['resistance', 'supports'],
      ['cell_imbalance', 'supports'],
      ['bms_recalibration', 'supports'],
    ]);
  });

  it('변화가 없으면 반박, 데이터가 없으면 no_data', () => {
    const same = Array.from({ length: 6 }, (_, i) => chargeSession({ day: 60 + i, capacityAh: 375, tCell: 25.5, ccAh: 340, cvS: 850, dvMv: 9 }));
    expect(capacityChecks(refs, same, [], DAY0, p).map((c) => c.status)).toEqual(['refutes', 'refutes', 'refutes', 'refutes', 'refutes']);
    const empty = same.map((s) => ({ ...s, features: { ...s.features, t_cell_mean: null, cc_ah: 0, cell_dv_end: null, soc_ocv_start: null } }));
    const statuses = capacityChecks(empty, empty, [], DAY0, p).map((c) => c.status);
    expect(statuses).toEqual(['no_data', 'refutes', 'no_data', 'no_data', 'no_data']);
    const partial = same.map((s, i) => ({ ...s, features: { ...s.features, t_cell_mean: 23, cv_s: 1000 + i, cc_ah: 339, cell_dv_end: 14 } }));
    expect(capacityChecks(refs, partial, [], DAY0, p).map((c) => c.status).slice(0, 4)).toEqual(['unknown', 'refutes', 'unknown', 'unknown']);
  });
});
