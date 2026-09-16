import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import { kstDayStart, MS_PER_DAY } from '../types';
import { H2_MASS_BALANCE_DEFAULTS, h2ChainMassBalanceGap, type H2LedgerDayInput, type H2MassBalanceInput } from './h2chain-mass-balance';
import { DAY0 } from './test-fixtures';

const DAYS = 60;
const FIRST_DAY = kstDayStart(DAY0);
const NOW = FIRST_DAY + DAYS * MS_PER_DAY;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface LedgerOptions {
  readonly seed: number;
  /** 날짜별 계량되지 않은 손실 비율 [%] */
  readonly lossPct: (day: number) => number;
  /** 잔차율에 더하는 탱크 온도 영향 [%/°C] */
  readonly tempCoupling?: number;
  readonly flowmeterBias?: (day: number) => number;
  readonly purgeCoupling?: number;
  readonly lowQualityDays?: readonly number[];
}

function ledger(o: LedgerOptions): H2LedgerDayInput[] {
  const rng = createRng(o.seed);
  return Array.from({ length: DAYS }, (_, day) => {
    const faraday = 100 + 10 * rng.next();
    const produced = faraday * 0.97 * (1 + (o.flowmeterBias?.(day) ?? 0) / 100);
    const tempDelta = 4 * Math.sin(day * 1.3);
    const purge = 20 + Math.round(10 * rng.next());
    const residualPct = o.lossPct(day) + (o.tempCoupling ?? 0) * tempDelta + (o.purgeCoupling ?? 0) * (purge - 25) + 0.3 * rng.gaussian();
    const residual = (produced * residualPct) / 100;
    const fc = 40 + 5 * rng.next();
    const vented = 0.5;
    return {
      day: FIRST_DAY + day * MS_PER_DAY,
      produced: produced,
      fc_consumed: fc,
      stored_delta: produced - fc - vented - residual,
      vented_est: vented,
      residual: residual,
      residual_pct: residualPct,
      dq: { completeness: o.lowQualityDays?.includes(day) ? 0.5 : 1 },
      faraday_expected: faraday,
      purge_count: purge,
      tank_temp_delta_c: tempDelta,
      ambient_range_c: 8,
    };
  });
}

const gapFrom = (day0: number, pct: number) => (day: number) => (day >= day0 ? pct : 0);
const run = (input: Partial<H2MassBalanceInput> & { days: readonly H2LedgerDayInput[] }, params = {}) => h2ChainMassBalanceGap.detect({ siteId: 3, ...input }, ctx(params));
const checksOf = (result: ReturnType<typeof run>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('h2chain.mass_balance_gap@2', () => {
  it('계량되지 않은 손실 3.5% 주입을 잔차율 중앙값 3.5% ± 15%로 잡고 사이트 단위 severity 2', () => {
    const result = run({ days: ledger({ seed: 2, lossPct: gapFrom(40, 3.5) }) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'h2chain.mass_balance_gap', assetId: null, failureMode: 'h2chain.mass_balance_gap', category: 'performance', severity: 2, effect: { metric: 'h2_residual_pct', unit: '%' } });
    expect(finding?.effect.value).toBeGreaterThan(3.5 * 0.85);
    expect(finding?.effect.value).toBeLessThan(3.5 * 1.15);
    expect(checksOf(result)).toEqual({ flowmeter_drift: 'refutes', temperature_compensation: 'refutes', purge_vent_estimate: 'refutes', storage_leak: 'no_data', missing_days: 'refutes', delivery_record: 'refutes' });
    expect((finding?.evidence.days as unknown[]).length).toBeLessThanOrEqual(120);
  });

  it('정지 보유 누설 결과가 잔차를 설명하면 severity 3, 누설 없음 결과면 반박', () => {
    const days = ledger({ seed: 3, lossPct: gapFrom(40, 3.5) });
    const leak = run({ days, staticLeak: { status: 'finding', leakKgPerDay: 3, ciLowKgPerDay: 2 } });
    expect(leak.status === 'ok' && leak.findings[0]?.severity).toBe(3);
    expect(checksOf(leak).storage_leak).toBe('supports');
    expect(checksOf(run({ days, staticLeak: { status: 'no_finding', leakKgPerDay: null, ciLowKgPerDay: null } })).storage_leak).toBe('refutes');
    expect(checksOf(run({ days, staticLeak: { status: 'finding', leakKgPerDay: 0.2, ciLowKgPerDay: 0.1 } })).storage_leak).toBe('unknown');
  });

  it('유량계 과다 계량·온도 보정 오차·퍼지 손실·결측일 신호를 판별 체크로 구분한다', () => {
    expect(checksOf(run({ days: ledger({ seed: 4, lossPct: () => 0, flowmeterBias: gapFrom(40, 3.5) }).map((d, i) => ({ ...d, residual_pct: i >= 40 ? 3.4 + 0.1 * Math.sin(i) : d.residual_pct })) })).flowmeter_drift).toBe('supports');
    expect(checksOf(run({ days: ledger({ seed: 5, lossPct: gapFrom(40, 3), tempCoupling: 0.4 }) })).temperature_compensation).toBe('supports');
    expect(checksOf(run({ days: ledger({ seed: 6, lossPct: gapFrom(40, 3), purgeCoupling: 0.3 }) })).purge_vent_estimate).toBe('supports');
    expect(checksOf(run({ days: ledger({ seed: 7, lossPct: gapFrom(40, 3.5), lowQualityDays: [53, 54] }) })).missing_days).toBe('supports');
  });

  it('음의 잔차(생산 과소 계량)도 같은 규칙으로 잡는다', () => {
    const result = run({ days: ledger({ seed: 8, lossPct: gapFrom(40, -3) }) });
    expect(result.status === 'ok' && result.findings[0]?.title).toMatch(/^수소 물질수지 잔차 -(2\.[6-9]|3\.[0-4])%$/);
    expect(result.status === 'ok' && result.findings[0]?.effect.value).toBeLessThan(-3 * 0.85);
  });

  it('대조군: 건강한 사이트(잔차 0 ± 잡음)·일교차로 흔들리는 잔차(±1.6%)는 0건, 기준 이후 계단이 아닌 원래 수준 2.5%는 CUSUM 경보가 없어 0건', () => {
    expect(run({ days: ledger({ seed: 9, lossPct: () => 0 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ days: ledger({ seed: 10, lossPct: () => 0, tempCoupling: 0.4 }) })).toEqual({ status: 'ok', findings: [] });
    expect(run({ days: ledger({ seed: 11, lossPct: () => 2.5 }) })).toEqual({ status: 'ok', findings: [] });
  });

  it('@2 반입: 반입량을 아는 날은 그대로 판정하고, 모르는 날(잔차 null)은 빼며 반입 기록 체크가 지지로 바뀐다', () => {
    // 반입이 생산의 2배인 사이트. 잔차율은 (생산 + 반입) 기준이라 반입을 넣지 않으면 매일 −66%가 된다
    const withDelivery = ledger({ seed: 20, lossPct: gapFrom(40, 3.5) }).map((d) => ({ ...d, delivered: (d.produced ?? 0) * 2 }));
    const found = run({ days: withDelivery });
    expect(found.status === 'ok' && found.findings.length).toBe(1);
    expect(checksOf(found).delivery_record).toBe('refutes');
    expect((found.status === 'ok' ? (found.findings[0]?.evidence.days as { delivered: number | null }[]) : []).every((d) => d.delivered !== null)).toBe(true);
    // 최근 7일 중 2일은 하역 계량·전표가 없어 원장이 잔차를 내지 못한 날이다 — 그 날은 판정에서 빠지고 체크가 지지가 된다
    const unknownDays = withDelivery.map((d, i) => (i >= DAYS - 2 ? { ...d, delivered: null, residual: null, residual_pct: null } : d));
    const partial = run({ days: unknownDays });
    expect(partial.status === 'ok' && partial.findings.length).toBe(1);
    expect(checksOf(partial).delivery_record).toBe('supports');
  });

  it('insufficient: 유효일 부족, 결정성·스키마 기본값', () => {
    const short = run({ days: ledger({ seed: 12, lossPct: () => 3 }).slice(0, 10) });
    expect(short.status === 'insufficient' && short.reason).toContain('유효한 수소 원장 일수 부족');
    const days = ledger({ seed: 13, lossPct: gapFrom(40, 4) });
    expect(run({ days })).toEqual(run({ days }));
    expect(h2ChainMassBalanceGap.paramSchema.parse({})).toEqual(H2_MASS_BALANCE_DEFAULTS);
    const windowed = h2ChainMassBalanceGap.detect({ siteId: 3, days }, { ...ctx(), referenceWindow: { start: FIRST_DAY, end: FIRST_DAY + 20 * MS_PER_DAY } });
    expect(windowed.status === 'ok' && windowed.findings.length).toBe(1);
  });
});
