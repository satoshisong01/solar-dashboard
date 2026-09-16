import { describe, expect, it } from 'vitest';
import { compareMapSites, countMapLevels, hasAlerts, mapLevelOf, sortMapSites, type MapLevel, type MapSignals } from './map-status';

const NOW = Date.UTC(2026, 8, 16, 3, 0, 0);
const SILENCE = 10 * 60_000;

const signals = (over: Partial<MapSignals> = {}): MapSignals => ({
  openFindingCount: 0,
  worstSeverity: null,
  hasSafetyFinding: false,
  lastSeenMs: NOW - 60_000,
  ...over,
});

const level = (over: Partial<MapSignals> = {}) => mapLevelOf(signals(over), NOW, SILENCE);

describe('mapLevelOf', () => {
  it('열린 발견사항이 없고 최근 수신이 있으면 정상', () => {
    expect(level()).toBe('normal');
  });

  it('심각도 4~5는 바로 확인, 2~3은 주의', () => {
    expect(level({ openFindingCount: 1, worstSeverity: 5 })).toBe('critical');
    expect(level({ openFindingCount: 1, worstSeverity: 4 })).toBe('critical');
    expect(level({ openFindingCount: 3, worstSeverity: 3 })).toBe('warning');
    expect(level({ openFindingCount: 1, worstSeverity: 2 })).toBe('warning');
  });

  it('심각도 1(관찰)은 수준을 올리지 않는다 — 플릿 매트릭스와 같은 규칙', () => {
    expect(level({ openFindingCount: 2, worstSeverity: 1 })).toBe('normal');
    expect(level({ openFindingCount: 2, worstSeverity: 1, lastSeenMs: NOW - SILENCE - 1 })).toBe('offline');
  });

  it('안전 발견사항은 심각도와 관계없이 바로 확인', () => {
    expect(level({ openFindingCount: 1, worstSeverity: 1, hasSafetyFinding: true })).toBe('critical');
  });

  it('건수가 0이면 최고 심각도가 남아 있어도 보지 않는다', () => {
    expect(level({ openFindingCount: 0, worstSeverity: 5 })).toBe('normal');
  });

  it('경계값: 공백 기준과 같으면 아직 수신 중, 넘으면 수신 없음', () => {
    expect(level({ lastSeenMs: NOW - SILENCE })).toBe('normal');
    expect(level({ lastSeenMs: NOW - SILENCE - 1 })).toBe('offline');
    expect(level({ lastSeenMs: null })).toBe('offline');
  });

  it('통신이 끊겨도 이미 찾아 둔 위험이 먼저다 (바로 확인·주의가 수신 없음을 이긴다)', () => {
    expect(level({ openFindingCount: 1, worstSeverity: 4, lastSeenMs: null })).toBe('critical');
    expect(level({ openFindingCount: 1, worstSeverity: 2, lastSeenMs: null })).toBe('warning');
  });

  it('시계 오차로 마지막 수신이 미래여도 수신 중으로 본다', () => {
    expect(level({ lastSeenMs: NOW + 5 * 60_000 })).toBe('normal');
  });

  it('공백 기준이 0 이하면 던진다', () => {
    expect(() => mapLevelOf(signals(), NOW, 0)).toThrow('silenceMs');
  });
});

const site = (code: string, level: MapLevel, worstSeverity: number | null = null, openFindingCount = 0) => ({ code, level, worstSeverity, openFindingCount });

describe('compareMapSites', () => {
  it('상태 나쁜 순 → 심각도 → 건수 → 코드 순', () => {
    const sorted = sortMapSites([
      site('SIM-C', 'normal'),
      site('SIM-A', 'warning', 3, 1),
      site('SIM-D', 'offline'),
      site('SIM-B', 'critical', 5, 2),
      site('SIM-E', 'warning', 3, 4),
    ]);
    expect(sorted.map((s) => s.code)).toEqual(['SIM-B', 'SIM-E', 'SIM-A', 'SIM-D', 'SIM-C']);
  });

  it('수신 없음은 정상보다 앞에 온다 (알 수 없는 것이 확인된 정상보다 급하다)', () => {
    expect(compareMapSites(site('B', 'offline'), site('A', 'normal'))).toBeLessThan(0);
  });

  it('모든 값이 같으면 코드 순이고, 정렬은 입력 배열을 바꾸지 않는다', () => {
    const input = [site('SIM-B', 'normal'), site('SIM-A', 'normal')];
    expect(sortMapSites(input).map((s) => s.code)).toEqual(['SIM-A', 'SIM-B']);
    expect(input.map((s) => s.code)).toEqual(['SIM-B', 'SIM-A']);
  });
});

describe('countMapLevels', () => {
  it('수준별 건수를 센다', () => {
    const counts = countMapLevels([site('A', 'critical'), site('B', 'warning'), site('C', 'warning'), site('D', 'offline')]);
    expect(counts).toEqual({ critical: 1, warning: 2, normal: 0, offline: 1 });
    expect(hasAlerts(counts)).toBe(true);
  });

  it('사이트가 없으면 모두 0이고 이상도 없다', () => {
    expect(countMapLevels([])).toEqual({ critical: 0, warning: 0, normal: 0, offline: 0 });
    expect(hasAlerts(countMapLevels([]))).toBe(false);
  });

  it('정상·수신 없음뿐이면 이상이 아니다', () => {
    expect(hasAlerts(countMapLevels([site('A', 'normal'), site('B', 'offline')]))).toBe(false);
  });
});
