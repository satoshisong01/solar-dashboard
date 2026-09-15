// 오늘 화면 안전 배너 규칙 (순수). 두 경로를 구분해 보여 준다:
//   안전 이벤트   수집 즉시 경로(event_log.is_safety). 확인(ack) 전까지 고정 — 분석을 거치지 않는다
//   안전 발견사항 분석 결과(카테고리 safety·심각도 4 이상, lib/desk/safety.ts)이면서 열린 상태(기각·효과 확인 제외). 상태가 닫히면 사라진다
import { isFindingStatus, isOpenStatus } from '@/lib/analysis/transition-rules';
import { isSafetyFinding } from '@/lib/desk/safety';

export const BANNER_ITEM_LIMIT = 3;

export interface SafetyFindingRow {
  readonly id: string;
  readonly siteCode: string;
  readonly assetPath: string | null;
  readonly detectorId: string;
  readonly category: string;
  readonly severity: number;
  readonly status: string;
  readonly title: string;
  readonly lastDetectedMs: number;
}

export interface SafetyFindingsBanner {
  readonly count: number;
  /** 심각도 내림차순 → 최근 탐지 순, 최대 BANNER_ITEM_LIMIT건 */
  readonly latest: readonly SafetyFindingRow[];
}

/** 열린 안전 발견사항만 골라 정렬한다 */
export function safetyFindingsBanner(rows: readonly SafetyFindingRow[]): SafetyFindingsBanner {
  const open = rows.filter((row) => isSafetyFinding(row) && isFindingStatus(row.status) && isOpenStatus(row.status));
  const sorted = [...open].sort((a, b) => b.severity - a.severity || b.lastDetectedMs - a.lastDetectedMs || (a.id < b.id ? 1 : -1));
  return { count: open.length, latest: sorted.slice(0, BANNER_ITEM_LIMIT) };
}

export type SafetyBannerTone = 'clear' | 'events' | 'findings' | 'both';

/** 배너 표시 구분: 안전 이벤트·안전 발견사항 유무 */
export function safetyBannerTone(eventCount: number, findingCount: number): SafetyBannerTone {
  if (eventCount > 0 && findingCount > 0) return 'both';
  if (eventCount > 0) return 'events';
  return findingCount > 0 ? 'findings' : 'clear';
}
