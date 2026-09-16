import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { MS_PER_DAY } from '../types';
import { GP_DAY0, htoDaysFixture, hxSamplesFixture, prvHoldsFixture } from './gapyeong-fixtures';
import { HX_FOULING_DEFAULTS, hxFouling, lmtd } from './hx-fouling';
import { O2_PURITY_DRIFT_DEFAULTS, o2PurityDrift } from './o2-purity-drift';
import { creepToNlPerMin, PRV_SEAT_LEAK_DEFAULTS, prvSeatLeak } from './prv-seat-leak';
import type { DetectorResult } from './types';

const DAYS = 40;
const NOW = GP_DAY0 + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });
const checksOf = (result: DetectorResult) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});
const from = (day0: number, value: number, before = 0) => (day: number) => (day >= day0 ? value : before);

describe('prv.seat_leak@1', () => {
  const run = (holds: ReturnType<typeof prvHoldsFixture>, params = {}) =>
    prvSeatLeak.detect({ assetId: 7, outletSetBar: 0.8, downstreamVolumeM3: 0.5, holds }, ctx(params));

  it('무유동 구간 크리프 60 mbar/h를 잡고 하류 체적으로 NL/min을 환산한다', () => {
    const result = run(prvHoldsFixture({ seed: 1, holds: DAYS, creepBarPerH: from(30, 0.06) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'prv.seat_leak', assetId: 7, failureMode: 'prv.seat_leak', category: 'degradation', severity: 2, effect: { metric: 'prv_creep_mbar_per_h', unit: 'mbar/h' } });
    expect(finding?.effect.value).toBeGreaterThan(55);
    expect(finding?.effect.value).toBeLessThan(65);
    expect((finding?.evidence as { leak_nl_per_min: number }).leak_nl_per_min).toBeCloseTo(creepToNlPerMin(0.06, 0.5), 2);
    expect(checksOf(result).supply_pressure).toBe('refutes');
  });

  it('주의 기준(130 mbar/h)을 넘으면 심각도가 오른다', () => {
    const result = run(prvHoldsFixture({ seed: 2, holds: DAYS, creepBarPerH: from(30, 0.2) }));
    expect(result.status === 'ok' && result.findings[0]?.severity).toBe(3);
  });

  it('대조군: 크리프가 없거나 공급압 효과로 설명되는 상승은 finding 0건이거나 공급압 체크가 지지', () => {
    expect(run(prvHoldsFixture({ seed: 3, holds: DAYS, creepBarPerH: () => 0 }))).toEqual({ status: 'ok', findings: [] });
    // 버퍼가 hold 동안 회복하면서 설정압이 따라 오르는 구성: 크리프는 잡히더라도 공급압 효과 체크가 지지로 나온다
    const supply = run(prvHoldsFixture({ seed: 4, holds: DAYS, creepBarPerH: () => 0, supplyCoupling: 0.05 }));
    expect(supply.status === 'ok' && supply.findings.length === 0 ? 'supports' : checksOf(supply).supply_pressure).toBe('supports');
  });

  it('insufficient: hold 구간 부족, 결정성·스키마 기본값', () => {
    const short = run(prvHoldsFixture({ seed: 5, holds: 2, creepBarPerH: () => 0.06 }));
    expect(short.status === 'insufficient' && short.reason).toContain('무유동 hold 구간 부족');
    const holds = prvHoldsFixture({ seed: 6, holds: DAYS, creepBarPerH: from(30, 0.06) });
    expect(run(holds)).toEqual(run(holds));
    expect(prvSeatLeak.paramSchema.parse({})).toEqual(PRV_SEAT_LEAK_DEFAULTS);
  });
});

describe('hx.fouling@1', () => {
  const run = (samples: ReturnType<typeof hxSamplesFixture>, params = {}) =>
    hxFouling.detect({ assetId: 9, designApproachK: 20, designUaKwK: 0.76, samples }, ctx(params));

  it('LMTD는 양측 온도차가 같으면 그 값, 부호가 다르면 null', () => {
    expect(lmtd(75, 74, 15, 55)).toBeGreaterThan(0);
    expect(lmtd(60, 60, 59, 59)).toBeCloseTo(1, 6);
    expect(lmtd(40, 39, 15, 55)).toBeNull();
  });

  it('UA 50% 저하를 접근온도 상승으로 잡고 UA 저하율도 함께 낸다', () => {
    const result = run(hxSamplesFixture({ seed: 11, days: DAYS, fouling: from(DAYS - 7, 0.5) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'hx.fouling', assetId: 9, failureMode: 'hx.heat_recovery_loss', category: 'performance', effect: { metric: 'hx_approach_k', unit: 'K' } });
    expect(finding?.effect.value).toBeGreaterThan(HX_FOULING_DEFAULTS.approachRiseK);
    const ua = (finding?.evidence as { ua: { drop_pct: number } | null }).ua;
    expect(ua?.drop_pct).toBeGreaterThan(30);
    expect(checksOf(result).ua_available).toBe('supports');
  });

  it('차압이 함께 오르면 스케일·막힘 체크가 지지, 그대로면 반박', () => {
    const scaled = run(hxSamplesFixture({ seed: 12, days: DAYS, fouling: from(DAYS - 7, 0.5), diffFactor: from(DAYS - 7, 1.5, 1) }));
    expect(checksOf(scaled).pressure_drop).toBe('supports');
    const film = run(hxSamplesFixture({ seed: 13, days: DAYS, fouling: from(DAYS - 7, 0.5) }));
    expect(checksOf(film).pressure_drop).toBe('refutes');
  });

  it('대조군: 오염이 없으면 0건. 2차측 입구 온도가 없으면 접근온도만으로 판정한다', () => {
    expect(run(hxSamplesFixture({ seed: 14, days: DAYS, fouling: () => 0 }))).toEqual({ status: 'ok', findings: [] });
    const noColdIn = hxSamplesFixture({ seed: 15, days: DAYS, fouling: from(DAYS - 7, 0.5) }).map((s) => ({ ...s, coldInC: null, heatKw: null }));
    const result = run(noColdIn);
    expect(result.status === 'ok' && result.findings.length).toBe(1);
    expect((result.status === 'ok' ? result.findings[0]?.evidence : null) as { ua: unknown } | null).toMatchObject({ ua: null });
    expect(checksOf(result).ua_available).toBe('refutes');
  });

  it('insufficient: 표본 부족, 결정성·스키마 기본값', () => {
    const short = run(hxSamplesFixture({ seed: 16, days: 3, fouling: () => 0.5 }));
    expect(short.status === 'insufficient' && short.reason).toContain('정상상태 표본 부족');
    const samples = hxSamplesFixture({ seed: 17, days: DAYS, fouling: from(DAYS - 7, 0.5) });
    expect(run(samples)).toEqual(run(samples));
    expect(hxFouling.paramSchema.parse({})).toEqual(HX_FOULING_DEFAULTS);
  });
});

describe('o2.purity_drift@1', () => {
  const run = (days: ReturnType<typeof htoDaysFixture>, input: Partial<Parameters<typeof o2PurityDrift.detect>[0]> = {}, params = {}) =>
    o2PurityDrift.detect({ assetId: 12, days, ...input }, ctx(params));

  it('HTO 0.6 → 1.3 vol% 상승을 안전 계열 심각도 4로 올리고 압축금지선 여유를 낸다', () => {
    const result = run(htoDaysFixture({ seed: 21, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 1.3 : 0.6) }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'o2.purity_drift', assetId: 12, failureMode: 'o2.purity_drift', category: 'safety', severity: 4, effect: { metric: 'h2_in_o2_pct', unit: 'vol%p' } });
    expect(finding?.effect.value).toBeGreaterThan(0.5);
    // 법정 압축금지선 2 vol%와 폭발하한 4 vol%가 근거에 남는다
    expect(finding?.evidence.limit).toMatchObject({ compression_stop_pct: 2, lel_pct: 4 });
    expect(finding?.summary).toContain('압축금지 한계');
  });

  it('법정 한계를 넘으면 심각도 5, 여유 체크가 지지', () => {
    const result = run(htoDaysFixture({ seed: 22, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 2.2 : 0.6) }));
    expect(result.status === 'ok' && result.findings[0]?.severity).toBe(5);
    expect(checksOf(result).legal_limit_margin).toBe('supports');
  });

  it('부분부하 비중이 늘어 오른 것이면 부분부하 체크가 지지한다', () => {
    const result = run(htoDaysFixture({ seed: 23, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 1.4 : 0.6), load: (d) => (d >= DAYS - 7 ? 0.3 : 0.7) }));
    expect(checksOf(result).part_load).toBe('supports');
    const steady = run(htoDaysFixture({ seed: 24, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 1.4 : 0.6) }));
    expect(checksOf(steady).part_load).toBe('refutes');
  });

  it('교정 이벤트가 있으면 계측 변경 체크가 지지', () => {
    const days = htoDaysFixture({ seed: 25, days: DAYS, htoPct: (d) => (d >= DAYS - 7 ? 1.4 : 0.6) });
    const result = run(days, { calibrationTs: [NOW - 6 * MS_PER_DAY] });
    expect(checksOf(result).analyzer_calibration).toBe('supports');
    expect(checksOf(run(days, { calibrationTs: [] })).analyzer_calibration).toBe('refutes');
  });

  it('대조군·insufficient: 평탄한 저농도는 0건, 운전일 부족은 판정 불능', () => {
    expect(run(htoDaysFixture({ seed: 26, days: DAYS, htoPct: () => 0.6 }))).toEqual({ status: 'ok', findings: [] });
    const short = run(htoDaysFixture({ seed: 27, days: 5, htoPct: () => 1.5 }));
    expect(short.status === 'insufficient' && short.reason).toContain('전해조 운전일 부족');
    // 하루 운전시간이 짧은 날은 표본에서 빠진다 (기동 구간만 있는 날은 HTO가 원래 높다)
    const brief = run(htoDaysFixture({ seed: 28, days: DAYS, htoPct: () => 1.8, hours: 1 }));
    expect(brief.status).toBe('insufficient');
    expect(o2PurityDrift.paramSchema.parse({})).toEqual(O2_PURITY_DRIFT_DEFAULTS);
  });
});
