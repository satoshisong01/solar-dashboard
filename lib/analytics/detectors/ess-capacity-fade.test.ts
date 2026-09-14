import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { MS_PER_DAY } from '../types';
import { capacityChecks, ESS_CAPACITY_DEFAULTS } from './index';
import { essCapacityFade, type EssCapacityInput } from './ess-capacity-fade';
import { restCycleHistory } from './rest-fixtures';
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
    expect(finding?.summary).toMatch(/같은 조건 충전 \d+회 비교: 유효용량 \d{3} Ah → 3\d\d Ah\(-[567]\.\d%, 95% CI -\d\.\d ~ -\d\.\d%\)/);
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
    const strict = essCapacityFade.detect(input(sessions), ctx(1, { params: { useCcAhFallback: false, useSocSpanFallback: false } }));
    expect(strict.status).toBe('insufficient');
  });

  it('앵커·CC 세션이 모두 없으면 충전 Ah ÷ SOC 변화 용량으로 비교한다', () => {
    const sessions = capacityHistory(400, 370, 18, { anchored: false, ccCapacity: false });
    const result = essCapacityFade.detect(input(sessions), ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.findings[0]?.effect.metric).toBe('capacity_ah_soc');
    expect(result.findings[0]?.effect.value).toBeCloseTo(-7.5, 0);
    expect(result.findings[0]?.summary).toContain('SOC 변화');
    expect(essCapacityFade.detect(input(sessions), ctx(1, { params: { useSocSpanFallback: false } })).status).toBe('insufficient');
  });

  it('세션이 부족하거나 정격이 없으면 insufficient와 이유', () => {
    const few = essCapacityFade.detect(input(capacityHistory(400, 375, 15).slice(0, 25)), ctx());
    expect(few).toMatchObject({ status: 'insufficient' });
    if (few.status === 'insufficient') expect(few.reason).toContain('표본 부족');
    expect(essCapacityFade.detect(input([], { ratedCapacityAh: 0 }), ctx()).status).toBe('insufficient');
  });

  it('기준선 재설정(resets_baseline) 이후 데이터만 쓰므로 그 전의 감소는 사라진다', () => {
    const sessions = capacityHistory(400, 375, 16);
    const findingsOf = (result: ReturnType<typeof essCapacityFade.detect>) => (result.status === 'ok' ? result.findings : []);
    const reset = essCapacityFade.detect(input(sessions, { events: [{ ts: DAY0 + 55 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: true }] }), ctx());
    expect(findingsOf(reset)).toEqual([]);
    const byContext = essCapacityFade.detect(input(sessions), ctx(1, { baselineResetAt: DAY0 + 65 * MS_PER_DAY }));
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

describe('ess.capacity_fade@1 휴지 앵커·bin별 기준 (연계형 부분 사이클)', () => {
  const fade = (from: number, to: number, total: number) => (day: number) => 400 * (1 - (total / 100) * Math.min(1, Math.max(0, (day - from) / (to - from))));
  const restInput = (history: ReturnType<typeof restCycleHistory>, extra: Partial<EssCapacityInput> = {}): EssCapacityInput =>
    input(history.charges, { discharges: history.discharges, rests: history.rests, ...extra });
  const evidenceOf = (result: ReturnType<typeof essCapacityFade.detect>) => (result.status === 'ok' ? (result.findings[0]?.evidence as Record<string, unknown> | undefined) : undefined);

  it('CV 종료 앵커가 없는 부분 사이클에서 휴지 앵커로 −6% 감소를 −6 ± 1%p로 추정하고 방식·방식별 표본 수·SOC 주의 코드를 남긴다', () => {
    const history = restCycleHistory({ days: 90, seed: 21, capacityAh: fade(20, 60, 6) });
    const result = essCapacityFade.detect(restInput(history), ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding?.effect.metric).toBe('rest_anchored');
    expect(finding?.effect.value).toBeGreaterThan(-7);
    expect(finding?.effect.value).toBeLessThan(-5);
    expect(finding?.effect.ciHigh).toBeLessThan(0);
    expect(finding?.summary).toContain('휴지 앵커');
    const evidence = evidenceOf(result) ?? {};
    expect(evidence.cautions).toEqual(['soc_estimate_depends_on_bms_recalibration']);
    expect(evidence.reference_mode).toBe('per_bin');
    expect(evidence.methods).toMatchObject({ capacity_ah_anchored: { status: 'insufficient', samples: 0 }, rest_anchored: { status: 'ok' } });
    const bins = evidence.bins as { key: string; used: boolean; ref_from: number | null; ref_to: number | null; excluded: string | null }[];
    expect(bins.map((b) => [b.key, b.used, b.excluded])).toEqual([
      ['chg|20', true, null],
      ['dis|20', true, null],
    ]);
    expect(bins.every((b) => b.ref_from !== null && b.ref_to !== null && b.ref_to < DAY0 + 10 * MS_PER_DAY)).toBe(true);
    expect(evidence.rest_pair_rules).toEqual({ rest_minutes: 30, min_delta_soc_pct: 25, soc_sigma_pct: 1 });
    // 대표 충전 곡선: 중앙값에 가까운 휴지 앵커 쌍 안의 충전 세션
    const curves = history.charges.map((c) => ({ start: c.start, points: [{ elapsed_s: 0, ah: 0, soc: 20 }, { elapsed_s: 18_000, ah: c.features.ah_in, soc: c.features.soc_end }] }));
    const withCurves = evidenceOf(essCapacityFade.detect(restInput(history, { curves }), ctx())) ?? {};
    const overlay = withCurves.overlay as { reference: { start: number } | null; recent: { start: number } | null };
    expect(history.charges.some((c) => c.start === overlay.reference?.start)).toBe(true);
    expect(overlay.recent?.start ?? 0).toBeGreaterThan(DAY0 + 60 * MS_PER_DAY);
  });

  it('계절이 바뀌어 셀 온도 bin이 달라져도 새 bin의 기준으로 판정한다 (여름 insufficient 해소, 변화 없으면 0건)', () => {
    const history = restCycleHistory({ days: 200, seed: 22, capacityAh: () => 400, tempC: (day) => (day < 120 ? 23 : 27) });
    const summer = essCapacityFade.detect(restInput(history), ctx(1, { now: DAY0 + 200 * MS_PER_DAY }));
    expect(summer).toEqual({ status: 'ok', findings: [] });
    // 첫 20 세션만 기준으로 쓰던 방식이면 여름(25°C bin)에 기준이 없다 → 기준 창을 봄까지로 고정하면 여름은 판정 불능
    const fixedWindow = essCapacityFade.detect(restInput(history), ctx(1, { now: DAY0 + 200 * MS_PER_DAY, referenceWindow: { start: DAY0 - MS_PER_DAY, end: DAY0 + 20 * MS_PER_DAY } }));
    expect(fixedWindow.status).toBe('insufficient');
  });

  it('SOC 상한 설정 변경(90% → 80%) 대조군: 휴지 앵커 판정이 ok인 상태에서 finding 0건', () => {
    const history = restCycleHistory({ days: 120, seed: 23, capacityAh: () => 400, socMaxPct: (day) => (day < 70 ? 90 : 80) });
    const events = [{ ts: DAY0 + 70 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: false }] as const;
    const result = essCapacityFade.detect(restInput(history, { events }), ctx(1, { now: DAY0 + 120 * MS_PER_DAY }));
    expect(result).toEqual({ status: 'ok', findings: [] });
  });

  it('판별 체크 ② SOC 상한 설정 변경은 용량 감소 판정이 나온 상황에서 설정 변경 기록·충전 종료 SOC 하락을 지지로 판정한다', () => {
    const history = restCycleHistory({ days: 90, seed: 24, capacityAh: fade(20, 60, 8), socMaxPct: (day) => (day < 55 ? 90 : 80) });
    const events = [{ ts: DAY0 + 55 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: false }] as const;
    const result = essCapacityFade.detect(restInput(history, { events }), ctx());
    expect(result.status === 'ok' && result.findings.length).toBe(1);
    const checks = (evidenceOf(result)?.checks ?? []) as { id: string; status: string; measured: Record<string, number> }[];
    expect(checks.find((c) => c.id === 'soc_setpoint')).toMatchObject({ status: 'supports', measured: { setpoint_changes: 1, soc_end_ref: 70, soc_end_recent: 65 } });
    const noEvent = essCapacityFade.detect(restInput(history), ctx());
    const noEventChecks = (evidenceOf(noEvent)?.checks ?? []) as { id: string; status: string }[];
    expect(noEventChecks.find((c) => c.id === 'soc_setpoint')?.status).toBe('supports'); // 기록이 없어도 충전 종료 SOC 중앙값 5%p 하락
  });

  it('휴지 앵커를 끄면 다음 방식으로 넘어가고, 모두 표본이 없으면 방식별 표본 수를 담은 insufficient', () => {
    const history = restCycleHistory({ days: 60, seed: 25, capacityAh: () => 400 });
    const off = essCapacityFade.detect(restInput(history), ctx(1, { now: DAY0 + 60 * MS_PER_DAY, params: { useRestAnchored: false } }));
    expect(off.status).toBe('insufficient');
    if (off.status === 'insufficient') expect(off.reason).toMatch(/앵커 기준 0·최근 0, CC 구간 기준 0·최근 0, SOC 변화 기준 0·최근 0/);
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
