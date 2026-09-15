// 분석 데스크 인박스 필터·정렬 규칙. 순수 모듈 (서버·클라이언트 공용).
//   정렬: 심각도×신뢰도 내림차순 → 심각도 → 최근 탐지 → id (모두 내림차순)
//   필터: 사이트 · 도메인(데이터 품질 카테고리는 '데이터품질' 열) · 카테고리 · 최소 심각도 · 상태(기본 열린 건)
import type { FindingCategory } from '@/lib/analytics/detectors/types';
import { CLOSED_STATUSES, FINDING_STATUSES, isFindingStatus, type FindingStatus } from '@/lib/analysis/transition-rules';
import { FLEET_COLUMNS, domainOfClass, domainOfSiteDetector, type FleetColumn } from '@/lib/data/domains';
import type { EffectView } from './effect';
import { isFindingCategory, SEVERITY_LEVELS } from './labels';

export interface InboxRow {
  readonly id: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly assetId: number | null;
  readonly assetPath: string | null;
  readonly assetName: string | null;
  readonly classKey: string | null;
  readonly detectorId: string;
  readonly category: FindingCategory;
  readonly severity: number;
  readonly confidence: number;
  readonly status: FindingStatus;
  readonly title: string;
  readonly effect: EffectView;
  readonly firstDetectedMs: number;
  readonly lastDetectedMs: number;
  readonly detectionCount: number;
  /** 닫힌 이전 건에서 이어진 재발이면 그 id */
  readonly previousFindingId: string | null;
}

export type StatusFilter = 'open' | 'all' | FindingStatus;

export interface InboxFilter {
  readonly site: string | null;
  readonly domain: FleetColumn | null;
  readonly category: FindingCategory | null;
  readonly minSeverity: number | null;
  readonly status: StatusFilter;
}

export const DEFAULT_INBOX_FILTER: InboxFilter = Object.freeze({ site: null, domain: null, category: null, minSeverity: null, status: 'open' });

type RawParams = Readonly<Record<string, string | undefined>>;

const isDomain = (value: string): value is FleetColumn => FLEET_COLUMNS.some((column) => column.key === value);
const SITE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/** URL 쿼리(site·domain·category·severity·status) → 필터. 틀린 값은 기본값으로 */
export function parseInboxFilter(params: RawParams): InboxFilter {
  const site = params.site?.trim() ?? '';
  const domain = params.domain ?? '';
  const category = params.category ?? '';
  const severity = Number(params.severity);
  const status = params.status ?? '';
  return {
    site: SITE_CODE_PATTERN.test(site) ? site : null,
    domain: isDomain(domain) ? domain : null,
    category: isFindingCategory(category) ? category : null,
    minSeverity: (SEVERITY_LEVELS as readonly number[]).includes(severity) ? severity : null,
    status: status === 'all' || isFindingStatus(status) ? status : 'open',
  };
}

/** 필터를 URL 쿼리로 (기본값인 항목은 뺀다) */
export function inboxSearch(filter: InboxFilter): string {
  const params = new URLSearchParams();
  if (filter.site) params.set('site', filter.site);
  if (filter.domain) params.set('domain', filter.domain);
  if (filter.category) params.set('category', filter.category);
  if (filter.minSeverity !== null) params.set('severity', String(filter.minSeverity));
  if (filter.status !== 'open') params.set('status', filter.status);
  return params.toString();
}

/** 발견사항이 속한 플릿 열: 데이터 품질 카테고리는 데이터품질 열, 설비가 있으면 설비 종류의 도메인, 사이트 단위(설비 없음)는 탐지기로 정한 도메인 */
export function domainOfFinding(row: Pick<InboxRow, 'category' | 'classKey'> & Partial<Pick<InboxRow, 'detectorId'>>): FleetColumn | null {
  if (row.category === 'data_quality') return 'dq';
  if (row.classKey !== null) return domainOfClass(row.classKey);
  return row.detectorId === undefined ? null : domainOfSiteDetector(row.detectorId);
}

export function matchesStatus(status: FindingStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'open') return !CLOSED_STATUSES.includes(status);
  return status === filter;
}

export function applyInboxFilter(rows: readonly InboxRow[], filter: InboxFilter): InboxRow[] {
  return rows.filter(
    (row) =>
      (filter.site === null || row.siteCode === filter.site) &&
      (filter.domain === null || domainOfFinding(row) === filter.domain) &&
      (filter.category === null || row.category === filter.category) &&
      (filter.minSeverity === null || row.severity >= filter.minSeverity) &&
      matchesStatus(row.status, filter.status),
  );
}

/** 심각도×신뢰도 (0~5) */
export const priorityOf = (row: Pick<InboxRow, 'severity' | 'confidence'>): number => row.severity * row.confidence;

const compareIds = (a: string, b: string): number => (a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length);

export function compareInbox(a: InboxRow, b: InboxRow): number {
  return priorityOf(b) - priorityOf(a) || b.severity - a.severity || b.lastDetectedMs - a.lastDetectedMs || compareIds(b.id, a.id);
}

export function sortInbox(rows: readonly InboxRow[]): InboxRow[] {
  return [...rows].sort(compareInbox);
}

/** 상태 필터 선택지 (열린 건 · 전체 · 상태별) */
export const STATUS_FILTER_OPTIONS: readonly StatusFilter[] = ['open', 'all', ...FINDING_STATUSES];
