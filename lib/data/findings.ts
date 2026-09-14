import 'server-only';
import { sql } from 'kysely';
import { isFindingStatus, type FindingStatus } from '@/lib/analysis/transition-rules';
import { db } from '@/lib/db/kysely';
import { parseEffect } from '@/lib/desk/effect';
import { sortInbox, type InboxRow } from '@/lib/desk/inbox';
import { isFindingCategory } from '@/lib/desk/labels';

/** 인박스가 한 번에 읽는 발견사항 수 (최근 탐지 순). 넘으면 화면에 알린다 */
export const INBOX_LIMIT = 500;

interface FindingSqlRow {
  readonly id: string;
  readonly site_code: string;
  readonly site_name: string;
  readonly asset_id: number | null;
  readonly asset_path: string | null;
  readonly asset_name: string | null;
  readonly class_key: string | null;
  readonly detector_id: string;
  readonly category: string;
  readonly severity: number;
  readonly confidence: number;
  readonly status: string;
  readonly title: string;
  readonly effect: unknown;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly detection_count: number;
  readonly previous_finding_id: string | null;
}

function baseQuery() {
  return db
    .selectFrom('om.finding as f')
    .innerJoin('om.site as s', 's.id', 'f.site_id')
    .leftJoin('om.asset as a', 'a.id', 'f.asset_id')
    .select([
      'f.id',
      's.code as site_code',
      's.name as site_name',
      'f.asset_id',
      'a.path as asset_path',
      'a.name as asset_name',
      'a.class_key',
      'f.detector_id',
      'f.category',
      'f.severity',
      'f.confidence',
      'f.status',
      'f.title',
      'f.effect',
      'f.first_detected_at',
      'f.last_detected_at',
      'f.detection_count',
      'f.previous_finding_id',
    ]);
}

function toInboxRow(row: FindingSqlRow): InboxRow[] {
  if (!isFindingStatus(row.status) || !isFindingCategory(row.category)) return [];
  return [
    {
      id: row.id,
      siteCode: row.site_code,
      siteName: row.site_name,
      assetId: row.asset_id,
      assetPath: row.asset_path,
      assetName: row.asset_name,
      classKey: row.class_key,
      detectorId: row.detector_id,
      category: row.category,
      severity: row.severity,
      confidence: row.confidence,
      status: row.status,
      title: row.title,
      effect: parseEffect(row.effect),
      firstDetectedMs: row.first_detected_at.getTime(),
      lastDetectedMs: row.last_detected_at.getTime(),
      detectionCount: row.detection_count,
      previousFindingId: row.previous_finding_id,
    },
  ];
}

/** 인박스 원본: 최근 탐지 순 INBOX_LIMIT건 (필터·정렬은 lib/desk/inbox.ts 순수 규칙이 한다) */
export async function listInboxRows(): Promise<Readonly<{ rows: readonly InboxRow[]; truncated: boolean }>> {
  const rows = await baseQuery().orderBy('f.last_detected_at', 'desc').orderBy('f.id', 'desc').limit(INBOX_LIMIT + 1).execute();
  return { rows: rows.slice(0, INBOX_LIMIT).flatMap(toInboxRow), truncated: rows.length > INBOX_LIMIT };
}

/** 오늘 화면 신규·악화 목록: 새 발견·다시 열림(조치 뒤 악화·재개) 중 심각도×신뢰도 상위 */
export async function listNewAndReopened(limit: number): Promise<readonly InboxRow[]> {
  const statuses: FindingStatus[] = ['new', 'reopened'];
  const rows = await baseQuery().where('f.status', 'in', statuses).execute();
  return sortInbox(rows.flatMap(toInboxRow)).slice(0, limit);
}

/** 이 기간 안에 계산된 조치 효과 검증을 "검증 결과 도착"으로 센다 */
export const VERIFICATION_ARRIVAL_MS = 7 * 86_400_000;

export interface FindingWorkCounts {
  readonly newCount: number;
  readonly triaged: number;
  readonly awaitingVerification: number;
  readonly verificationsArrived: number;
}

export async function getFindingWorkCounts(nowMs: number): Promise<FindingWorkCounts> {
  const [statusRows, arrived] = await Promise.all([
    db.selectFrom('om.finding').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute(),
    db
      .selectFrom('om.action_verification')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('computed_at', '>=', new Date(nowMs - VERIFICATION_ARRIVAL_MS))
      .executeTakeFirst(),
  ]);
  const count = (status: FindingStatus) => statusRows.find((row) => row.status === status)?.n ?? 0;
  return { newCount: count('new'), triaged: count('triaged'), awaitingVerification: count('action_taken'), verificationsArrived: arrived?.n ?? 0 };
}

export interface OpenFindingGroup {
  readonly siteId: number;
  readonly classKey: string | null;
  readonly category: string;
  readonly count: number;
  readonly maxSeverity: number;
}

/** 플릿 매트릭스용: 열린 발견사항을 사이트·설비 종류·카테고리로 묶은 건수와 최고 심각도 */
export async function getOpenFindingGroups(): Promise<readonly OpenFindingGroup[]> {
  const { rows } = await sql<{ site_id: number; class_key: string | null; category: string; n: number; max_severity: number }>`
    SELECT f.site_id, a.class_key, f.category, count(*)::int AS n, max(f.severity)::int AS max_severity
    FROM om.finding f LEFT JOIN om.asset a ON a.id = f.asset_id
    WHERE f.status NOT IN ('verified', 'dismissed')
    GROUP BY f.site_id, a.class_key, f.category
  `.execute(db);
  return rows.map((row) => ({ siteId: row.site_id, classKey: row.class_key, category: row.category, count: row.n, maxSeverity: row.max_severity }));
}
