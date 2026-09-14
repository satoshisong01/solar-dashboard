import { describe, expect, it } from 'vitest';
import type { SiteTotals } from './manifest';
import { evaluateIngest, type IngestObservation, type RollupObservation, type SiteObservation, type VerifyExpectation } from './verify-checks';

const totals = (overrides: Partial<SiteTotals> = {}): SiteTotals => ({ batches: 10, expectedSamples: 1_000, expectedUnmappedSamples: 0, clockSuspectSamples: 0, criticalEvents: 0, ...overrides });
const site = (overrides: Partial<SiteObservation> = {}): SiteObservation => ({ samples: 1_000, clockSuspect: 0, late: 1_000, safetyEvents: 0, unmapped: [], ...overrides });
const ROLLUP: RollupObservation = { buckets: 500, missingRollups: 0, orphanRollups: 0, exactMismatches: 0, floatBitDiffs: 0, floatMismatches: 0, maxScaledDiff: 0, dirtyRemaining: 0 };

const EXPECTED: VerifyExpectation = {
  sites: { 'SIM-A': totals({ clockSuspectSamples: 40 }), 'SIM-B': totals({ expectedUnmappedSamples: 20, criticalEvents: 1 }) },
  intendedUnmapped: new Map([['SIM-B', ['ELZ1/DRYER/DEWPOINT', 'COMP1/VIB_RMS']]]),
};
const OBSERVED: IngestObservation = {
  sites: {
    'SIM-A': site({ clockSuspect: 40 }),
    'SIM-B': site({ safetyEvents: 1, unmapped: [{ sourceKey: 'ELZ1/DRYER/DEWPOINT', sampleCount: 10 }, { sourceKey: 'COMP1/VIB_RMS', sampleCount: 10 }] }),
  },
  rollup: ROLLUP,
};

const statuses = (expected: VerifyExpectation, observed: IngestObservation) => Object.fromEntries(evaluateIngest(expected, observed).map((c) => [c.id, c.status]));
const withSite = (code: string, patch: Partial<SiteObservation>): IngestObservation => ({
  ...OBSERVED,
  sites: { ...OBSERVED.sites, [code]: { ...(OBSERVED.sites[code] ?? site()), ...patch } },
});

describe('evaluateIngest', () => {
  it('기대치와 관측이 맞으면 (a)~(e) 모두 통과', () => {
    expect(statuses(EXPECTED, OBSERVED)).toEqual({ a: 'pass', b: 'pass', c: 'pass', d: 'pass', e: 'pass' });
  });

  it('(a) 사이트 하나라도 행 수가 다르면 실패', () => {
    expect(statuses(EXPECTED, withSite('SIM-A', { samples: 999 })).a).toBe('fail');
  });

  it.each<[string, Partial<RollupObservation>]>([
    ['남은 dirty', { dirtyRemaining: 1 }],
    ['m_1h 누락', { missingRollups: 1 }],
    ['원시 없는 m_1h', { orphanRollups: 1 }],
    ['정수·min/max/first/last 불일치', { exactMismatches: 1 }],
    ['avg·sum 허용오차 초과', { floatMismatches: 1 }],
  ])('(b) %s가 있으면 실패', (_label, patch) => {
    expect(statuses(EXPECTED, { ...OBSERVED, rollup: { ...ROLLUP, ...patch } }).b).toBe('fail');
  });

  it('(b) avg·sum 비트 차이만 있고 허용오차 안이면 통과', () => {
    expect(statuses(EXPECTED, { ...OBSERVED, rollup: { ...ROLLUP, floatBitDiffs: 3, maxScaledDiff: 1e-15 } }).b).toBe('pass');
  });

  it('(c) 의도한 태그가 없거나, 의도하지 않은 태그가 있거나, 샘플 수가 모자라면 실패', () => {
    const only = (unmapped: SiteObservation['unmapped']) => statuses(EXPECTED, withSite('SIM-B', { unmapped })).c;

    expect(only([{ sourceKey: 'COMP1/VIB_RMS', sampleCount: 20 }])).toBe('fail');
    expect(only([...(OBSERVED.sites['SIM-B']?.unmapped ?? []), { sourceKey: 'TYPO/TAG', sampleCount: 1 }])).toBe('fail');
    expect(only([{ sourceKey: 'ELZ1/DRYER/DEWPOINT', sampleCount: 5 }, { sourceKey: 'COMP1/VIB_RMS', sampleCount: 5 }])).toBe('fail');
  });

  it('(d) critical 경보를 보냈는데 안전 이벤트가 없으면 실패, 보낸 경보가 없으면 건너뜀', () => {
    const healthy: VerifyExpectation = { ...EXPECTED, sites: { 'SIM-B': totals({ expectedUnmappedSamples: 20 }) } };

    expect(statuses(EXPECTED, withSite('SIM-B', { safetyEvents: 0 })).d).toBe('fail');
    expect(statuses(healthy, OBSERVED).d).toBe('skip');
  });

  it('(e) CLOCK_SUSPECT가 기대치와 다르거나 LATE가 한 건도 없으면 실패', () => {
    expect(statuses(EXPECTED, withSite('SIM-A', { clockSuspect: 39 })).e).toBe('fail');
    expect(statuses(EXPECTED, withSite('SIM-B', { clockSuspect: 1 })).e).toBe('fail');
    expect(statuses(EXPECTED, { ...OBSERVED, sites: { 'SIM-A': site({ clockSuspect: 40, late: 0 }), 'SIM-B': site({ late: 0, safetyEvents: 1 }) } }).e).toBe('fail');
  });

  it('(c) 미매핑 예정 태그가 없는 사이트만 적재했으면 건너뜀', () => {
    const expected: VerifyExpectation = { sites: { 'SIM-C': totals() }, intendedUnmapped: new Map() };

    expect(statuses(expected, { ...OBSERVED, sites: { 'SIM-C': site() } }).c).toBe('skip');
  });
});
