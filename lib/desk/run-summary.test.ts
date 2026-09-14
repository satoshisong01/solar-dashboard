import { describe, expect, it } from 'vitest';
import { formatElapsedMs, parseRunScope, summarizeRunStats } from './run-summary';

describe('formatElapsedMs', () => {
  it('초 → 분·초 → 시간·분', () => {
    expect(formatElapsedMs(43_147)).toBe('43초');
    expect(formatElapsedMs(60_400)).toBe('1분 0초');
    expect(formatElapsedMs(67_000)).toBe('1분 7초');
    expect(formatElapsedMs(3_900_000)).toBe('1시간 5분');
    expect(formatElapsedMs(null)).toBe('—');
  });
});

describe('summarizeRunStats', () => {
  it('사이트별 finding·탐지기·검증 통계를 합친다 (npm run analyze 실행 통계 형식)', () => {
    const stats = {
      sites: [
        {
          siteCode: 'SIM-A',
          findings: { created: 3, updated: 1, worsened: 0, suppressed: 1, recurrences: 0 },
          detectors: { 'ess.capacity_fade': { ok: 4, insufficient: 0, error: 0, findings: 1 }, 'pv.inverter_peer': { ok: 0, insufficient: 1, error: 0, findings: 0 } },
          verification: { checked: 1, verifiedFindings: 1 },
        },
        {
          siteCode: 'SIM-B',
          findings: { created: 2, updated: 0, worsened: 1, suppressed: 0, recurrences: 1 },
          detectors: { 'ess.capacity_fade': { ok: 0, insufficient: 2, error: 1, findings: 0 } },
          verification: null,
        },
      ],
      errors: [{ stage: 'detect', siteId: 2, message: 'x' }],
      elapsedMs: 43_147,
      budgetExceeded: false,
    };
    expect(summarizeRunStats(stats)).toEqual({
      created: 5,
      updated: 1,
      worsened: 1,
      suppressed: 1,
      recurrences: 1,
      insufficient: 3,
      insufficientDetectors: ['ess.capacity_fade', 'pv.inverter_peer'],
      detectorErrors: 1,
      runErrors: 1,
      verificationsChecked: 1,
      verifiedFindings: 1,
      elapsedMs: 43_147,
      budgetExceeded: false,
    });
  });

  it('실패 실행의 stats({ error })나 깨진 값은 0으로 읽는다', () => {
    const summary = summarizeRunStats({ error: '잠금' });
    expect(summary).toMatchObject({ created: 0, insufficient: 0, insufficientDetectors: [], runErrors: 0, elapsedMs: null, budgetExceeded: false });
    expect(summarizeRunStats('bad').created).toBe(0);
  });
});

describe('parseRunScope', () => {
  it('사이트·설비·기간을 읽고, 설비가 없으면 null', () => {
    expect(parseRunScope({ siteIds: [1, 2], from: '2026-05-17T17:00:00.000Z', to: '2026-09-14T17:00:00.000Z' })).toEqual({
      siteIds: [1, 2],
      assetIds: null,
      fromMs: Date.parse('2026-05-17T17:00:00.000Z'),
      toMs: Date.parse('2026-09-14T17:00:00.000Z'),
      verifyOnly: false,
    });
    expect(parseRunScope({ siteIds: [1], assetIds: [5, 'x'], from: 'bad' })).toEqual({ siteIds: [1], assetIds: [5], fromMs: null, toMs: null, verifyOnly: false });
    expect(parseRunScope({ siteIds: [1], mode: 'verify' }).verifyOnly).toBe(true);
  });
});
