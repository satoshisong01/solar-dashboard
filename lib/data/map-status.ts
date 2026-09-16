// 지도 마커 상태 규칙. 순수 함수 (now 주입). 서버·클라이언트 공용.
// 플릿 매트릭스(lib/data/fleet-status.ts)가 사이트×도메인 셀을 여러 신호로 판정한다면,
// 이 규칙은 지도에서 한눈에 보는 "이 발전소에 지금 사람이 가야 하는가"만 본다: 열린 발견사항과 수신 여부.

/** 바로 확인(빨강) · 주의(주황) · 정상(초록) · 수신 없음(회색) */
export type MapLevel = 'critical' | 'warning' | 'normal' | 'offline';

export const MAP_LEVELS: readonly MapLevel[] = ['critical', 'warning', 'normal', 'offline'];

export const MAP_LEVEL_LABELS: Readonly<Record<MapLevel, string>> = {
  critical: '바로 확인',
  warning: '주의',
  normal: '정상',
  offline: '수신 없음',
};

/** 심각도 기준: 플릿 매트릭스와 같은 값을 쓴다 (lib/data/fleet-status.ts FLEET_THRESHOLDS) */
export const MAP_SEVERITY = Object.freeze({ critical: 4, warning: 2 });

export interface MapSignals {
  /** 열린 발견사항(기각·효과 확인 제외) 수 */
  readonly openFindingCount: number;
  /** 그중 최고 심각도. 없으면 null */
  readonly worstSeverity: number | null;
  /** 열린 안전 발견사항(안전 카테고리·심각도 4 이상)이 있는가 */
  readonly hasSafetyFinding: boolean;
  /** 활성 게이트웨이의 마지막 수신 시각. 수신 기록이 없거나 활성 게이트웨이가 없으면 null */
  readonly lastSeenMs: number | null;
}

/**
 * 지도 색 판정.
 *   1. 안전 발견사항 또는 심각도 4~5 → 바로 확인
 *   2. 심각도 2~3 → 주의
 *   3. 마지막 수신이 안전감시 공백 기준(silenceMs)을 넘었거나 수신 기록이 없음 → 수신 없음
 *   4. 그 밖 → 정상
 * 심각도 1(관찰)은 플릿 규칙과 같이 수준을 올리지 않는다.
 * 1·2가 3보다 앞서는 이유: 통신이 끊겼어도 이미 찾아 둔 위험은 사라지지 않아 현장 확인이 먼저다.
 */
export function mapLevelOf(signals: MapSignals, nowMs: number, silenceMs: number): MapLevel {
  if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new Error(`silenceMs는 0보다 커야 합니다: ${silenceMs}`);
  const severity = signals.openFindingCount > 0 ? signals.worstSeverity : null;
  if (signals.hasSafetyFinding || (severity !== null && severity >= MAP_SEVERITY.critical)) return 'critical';
  if (severity !== null && severity >= MAP_SEVERITY.warning) return 'warning';
  if (signals.lastSeenMs === null || nowMs - signals.lastSeenMs > silenceMs) return 'offline';
  return 'normal';
}

const LEVEL_RANK: Readonly<Record<MapLevel, number>> = { critical: 0, warning: 1, offline: 2, normal: 3 };

export interface MapSiteOrder {
  readonly level: MapLevel;
  readonly worstSeverity: number | null;
  readonly openFindingCount: number;
  readonly code: string;
}

/** 상태 나쁜 순 → 심각도 높은 순 → 건수 많은 순 → 코드 순 (같은 입력이면 항상 같은 순서) */
export function compareMapSites(a: MapSiteOrder, b: MapSiteOrder): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    (b.worstSeverity ?? 0) - (a.worstSeverity ?? 0) ||
    b.openFindingCount - a.openFindingCount ||
    a.code.localeCompare(b.code)
  );
}

export function sortMapSites<T extends MapSiteOrder>(sites: readonly T[]): readonly T[] {
  return [...sites].sort(compareMapSites);
}

export type MapLevelCounts = Readonly<Record<MapLevel, number>>;

/** 상단 요약: '바로 확인 N · 주의 N · 정상 N · 수신 없음 N' */
export function countMapLevels(sites: readonly Readonly<{ level: MapLevel }>[]): MapLevelCounts {
  return MAP_LEVELS.reduce(
    (counts, level) => ({ ...counts, [level]: sites.filter((site) => site.level === level).length }),
    { critical: 0, warning: 0, normal: 0, offline: 0 },
  );
}

/** 왼쪽 위 상태 칩: 하나라도 바로 확인·주의가 있으면 이상, 모두 정상·수신 없음이면 정상 */
export const hasAlerts = (counts: MapLevelCounts): boolean => counts.critical > 0 || counts.warning > 0;
