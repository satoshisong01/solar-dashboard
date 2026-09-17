// 열린 발견사항 집계 (순수). 문장은 만들지 않는다 — 여기서 센 값만 template.ts가 문장으로 옮긴다.
// 분류 기준은 화면 다른 곳과 같은 규칙을 그대로 쓴다: 열린 건 판정·계통(FleetColumn)·정렬은 lib/desk/inbox.ts.
import { hashInput } from '@/lib/analytics/hash';
import { FLEET_COLUMNS } from '@/lib/data/domains';
import { applyInboxFilter, DEFAULT_INBOX_FILTER, domainOfFinding, sortInbox, type InboxRow } from '@/lib/desk/inbox';
import { assetCodeOf, subjectText } from '@/lib/desk/plain/common';
import { plainHeadline } from '@/lib/desk/plain/headline';
import type { DigestCount, DigestDomain, DigestGroup, DigestItem, DigestStats, DigestUrgency } from './types';

/** 전문 용어 대신 현장에서 부르는 말 (플릿 열 이름은 표 머리라 짧게 쓰지만 문장에는 이 말을 쓴다) */
export const DOMAIN_LABELS: Readonly<Record<DigestDomain, string>> = {
  pv: '태양광',
  ess: '배터리',
  electrolyzer: '전해조',
  storage: '수소 저장·압축',
  fuelcell: '연료전지',
  dq: '데이터 품질',
  other: '그 밖',
};

export const URGENCY_LABELS: Readonly<Record<DigestUrgency, string>> = {
  now: '바로 확인',
  week: '이번 주 확인',
  watch: '지켜보기',
};

const DOMAIN_ORDER: readonly DigestDomain[] = [...FLEET_COLUMNS.map((column) => column.key), 'other'];
const URGENCY_ORDER: readonly DigestUrgency[] = ['now', 'week', 'watch'];

/** 문장에 이름을 대는 가장 심각한 건 수 */
export const DIGEST_TOP_LIMIT = 3;

/** 심각도 → 급함 (lib/desk/plain/common.ts severityAction과 같은 경계. '참고'(1)는 지켜보기로 묶는다) */
export function urgencyOf(severity: number): DigestUrgency {
  if (severity >= 4) return 'now';
  return severity === 3 ? 'week' : 'watch';
}

/** 이 요약이 세는 발견사항: 열린 건만, 사이트 필터가 걸려 있으면 그 사이트만 (인박스 기본 필터와 같다) */
export function openFindingsFor(rows: readonly InboxRow[], site: string | null): InboxRow[] {
  return sortInbox(applyInboxFilter(rows, { ...DEFAULT_INBOX_FILTER, site }));
}

/** 인박스 행에는 설비 경로만 있다 — 인박스·대시보드 한 줄 요약과 같은 방식으로 코드를 뽑아 쓴다 */
function itemOf(row: InboxRow): DigestItem {
  const input = { ...row, assetCode: assetCodeOf(row.assetPath) };
  return {
    id: row.id,
    headline: plainHeadline(input),
    subject: subjectText(input),
    siteCode: row.siteCode,
    severity: row.severity,
    domain: domainOfFinding(row) ?? 'other',
    urgency: urgencyOf(row.severity),
  };
}

/** key별 건수를 많은 순으로 (같으면 order에 적힌 순서, 그마저 같으면 key 순) */
function countBy<K extends string>(items: readonly DigestItem[], keyOf: (item: DigestItem) => K, labelOf: (key: K) => string, order: readonly K[]): DigestCount<K>[] {
  const counts = items.reduce((map, item) => map.set(keyOf(item), (map.get(keyOf(item)) ?? 0) + 1), new Map<K, number>());
  const rank = (key: K): number => (order.indexOf(key) < 0 ? order.length : order.indexOf(key));
  return [...counts.entries()]
    .map(([key, count]): DigestCount<K> => ({ key, label: labelOf(key), count }))
    .sort((a, b) => b.count - a.count || rank(a.key) - rank(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const domainCounts = (items: readonly DigestItem[]): DigestCount<DigestDomain>[] => countBy(items, (item) => item.domain, (key) => DOMAIN_LABELS[key], DOMAIN_ORDER);

function groupsOf(items: readonly DigestItem[]): DigestGroup[] {
  return domainCounts(items).map((domain) => ({
    key: domain.key,
    label: domain.label,
    count: domain.count,
    urgencies: URGENCY_ORDER.flatMap((urgency) => {
      const inGroup = items.filter((item) => item.domain === domain.key && item.urgency === urgency);
      return inGroup.length === 0 ? [] : [{ key: urgency, label: URGENCY_LABELS[urgency], items: inGroup }];
    }),
  }));
}

/**
 * 열린 발견사항 집계. rows는 openFindingsFor가 고르고 정렬한 것이어야 한다
 * (top은 rows 순서를 그대로 쓴다 = 심각도×신뢰도 순).
 * truncatedAt은 rows를 읽어 온 조회가 최근 탐지 N건에서 잘렸을 때 그 N이다 (안 잘렸으면 null).
 */
export function buildDigestStats(rows: readonly InboxRow[], site: string | null, truncatedAt: number | null = null): DigestStats {
  const items = rows.map(itemOf);
  return {
    site,
    truncatedAt,
    siteLabel: site === null ? null : (rows[0]?.siteName ?? site),
    total: items.length,
    newCount: rows.filter((row) => row.status === 'new').length,
    reopenedCount: rows.filter((row) => row.status === 'reopened').length,
    byDomain: domainCounts(items),
    byUrgency: URGENCY_ORDER.map((key) => ({ key, label: URGENCY_LABELS[key], count: items.filter((item) => item.urgency === key).length })),
    bySite: countBy(items, (item) => item.siteCode, (key) => key, []),
    top: items.slice(0, DIGEST_TOP_LIMIT),
    groups: groupsOf(items),
  };
}

/**
 * 발견사항 묶음의 지문: 같은 값이면 저장해 둔 요약을 그대로 쓴다.
 * 건수·id·상태·심각도만 본다 — 이 넷이 그대로면 집계 결과도 그대로다.
 */
export function digestFingerprint(rows: readonly InboxRow[], site: string | null): string {
  const ids = rows.map((row) => `${row.id}:${row.status}:${row.severity}`).sort();
  return hashInput({ site, count: ids.length, ids });
}
