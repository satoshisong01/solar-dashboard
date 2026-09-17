import { describe, expect, it } from 'vitest';
import { formatElapsedMs, parseRunProgress, parseRunScope, runProgressText, summarizeRunStats, unfinishedSiteIds } from './run-summary';

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
      skippedSiteCodes: [],
    });
  });

  it('시간 예산을 넘겨 건너뛴 사이트 코드를 남긴다 (실행 이력에 그대로 보인다)', () => {
    const stats = {
      sites: [
        { siteCode: 'SIM-A', skipped: [] },
        { siteCode: 'GP-1', skipped: ['extract:H2BUF1/TANK1', 'kpi', 'detect', 'verify'] },
        { siteCode: 'SIM-D', skipped: ['kpi', 'detect', 'verify'] },
      ],
      budgetExceeded: true,
    };
    expect(summarizeRunStats(stats).skippedSiteCodes).toEqual(['GP-1', 'SIM-D']);
    expect(summarizeRunStats(stats).budgetExceeded).toBe(true);
  });

  it('실패 실행의 stats({ error })나 깨진 값은 0으로 읽는다', () => {
    const summary = summarizeRunStats({ error: '잠금' });
    expect(summary).toMatchObject({ created: 0, insufficient: 0, insufficientDetectors: [], runErrors: 0, elapsedMs: null, budgetExceeded: false, skippedSiteCodes: [] });
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

describe('parseRunProgress · runProgressText', () => {
  it('실행 중 stats.progress를 읽어 한 줄로 만든다', () => {
    const progress = parseRunProgress({ progress: { siteCode: 'SIM-B', siteIndex: 2, siteCount: 4, stage: 'detect', atMs: 1_700_000_000_000 } });
    expect(progress).toEqual({ siteCode: 'SIM-B', siteIndex: 2, siteCount: 4, stage: 'detect', atMs: 1_700_000_000_000 });
    expect(runProgressText(progress)).toBe('SIM-B (2/4) · 탐지');
  });

  it('사이트가 하나면 번호를 붙이지 않고, 사이트 앞 단계는 단계만 쓴다', () => {
    expect(runProgressText(parseRunProgress({ progress: { siteCode: 'SIM-A', siteIndex: 1, siteCount: 1, stage: 'verify' } }))).toBe('SIM-A · 조치 효과 검증');
    expect(runProgressText(parseRunProgress({ progress: { siteCode: null, siteIndex: 0, siteCount: 2, stage: 'rollup' } }))).toBe('남은 롤업 처리');
  });

  it('진행 상황이 없거나(끝난 실행) 깨졌으면 null → 준비 중', () => {
    expect(parseRunProgress({ sites: [] })).toBeNull();
    expect(parseRunProgress('bad')).toBeNull();
    expect(runProgressText(null)).toBe('준비 중');
    expect(runProgressText(parseRunProgress({ progress: { stage: 'made_up' } }))).toBe('made_up');
  });
});

describe('unfinishedSiteIds', () => {
  const scope = parseRunScope({ siteIds: [1, 2, 3], from: '2026-05-17T17:00:00.000Z', to: '2026-09-14T17:00:00.000Z' });

  it('건너뛴 단계가 있거나 통계에 아예 없는 사이트만 남긴다', () => {
    const stats = { sites: [{ siteId: 1, skipped: [] }, { siteId: 2, skipped: ['kpi', 'detect', 'verify'] }] };
    expect(unfinishedSiteIds(scope, stats)).toEqual([2, 3]);
  });

  it('모두 끝났으면 빈 배열, 통계가 깨졌으면 전부 남은 것으로 본다', () => {
    expect(unfinishedSiteIds(scope, { sites: [{ siteId: 1, skipped: [] }, { siteId: 2, skipped: [] }, { siteId: 3, skipped: [] }] })).toEqual([]);
    expect(unfinishedSiteIds(scope, { error: '잠금' })).toEqual([1, 2, 3]);
  });
});
