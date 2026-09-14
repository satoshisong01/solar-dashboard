import 'server-only';
import { sql } from 'kysely';
import { isFindingStatus, type FindingStatus } from '@/lib/analysis/transition-rules';
import { db } from '@/lib/db/kysely';
import { parseStoredValidation, type StoredValidationView } from '@/lib/report/citations';
import { readStoredPack } from '@/lib/report/evidence-pack';
import type { EvidencePack, PackPeriod } from '@/lib/report/pack-types';
import { parseReviewDraft, type ReviewDraft } from '@/lib/report/review';

export const REPORT_LIST_LIMIT = 100;
/** 리포트 만들기 기본 선택: 열린 발견사항 중 이 심각도 이상 */
export const DEFAULT_MIN_SEVERITY = 2;

export interface ReportListRow {
  readonly id: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly periodLabel: string;
  readonly periodFromMs: number;
  readonly status: string;
  readonly validationOk: boolean;
  readonly issueCount: number;
  readonly findingCount: number;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly approvedBy: string | null;
  readonly approvedAtMs: number | null;
}

export async function listReports(siteCode: string | null): Promise<readonly ReportListRow[]> {
  const { rows } = await sql<{
    id: string;
    code: string;
    name: string;
    label: string | null;
    from_ms: number;
    status: string;
    validation_ok: boolean | null;
    issue_count: number | null;
    finding_count: number | null;
    created_by: string;
    created_at: Date;
    approved_by: string | null;
    approved_at: Date | null;
  }>`
    SELECT r.id, s.code, s.name, r.pack -> 'period' ->> 'label' AS label, (extract(epoch FROM lower(r.period)) * 1000)::float8 AS from_ms, r.status,
      (r.validation ->> 'ok')::boolean AS validation_ok, jsonb_array_length(COALESCE(r.validation -> 'issues', '[]'::jsonb)) AS issue_count,
      jsonb_array_length(COALESCE(r.pack -> 'findings', '[]'::jsonb)) AS finding_count, r.created_by, r.created_at, r.approved_by, r.approved_at
    FROM om.report r JOIN om.site s ON s.id = r.site_id
    WHERE (${siteCode}::text IS NULL OR s.code = ${siteCode})
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${REPORT_LIST_LIMIT}
  `.execute(db);
  return rows.map((r) => ({
    id: r.id,
    siteCode: r.code,
    siteName: r.name,
    periodLabel: r.label ?? '—',
    periodFromMs: r.from_ms,
    status: r.status,
    validationOk: r.validation_ok === true,
    issueCount: r.issue_count ?? 0,
    findingCount: r.finding_count ?? 0,
    createdBy: r.created_by,
    createdAtMs: r.created_at.getTime(),
    approvedBy: r.approved_by,
    approvedAtMs: r.approved_at ? r.approved_at.getTime() : null,
  }));
}

export interface ReportSiteOption {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}

export async function listReportSites(): Promise<readonly ReportSiteOption[]> {
  return db.selectFrom('om.site').select(['id', 'code', 'name']).orderBy('code').execute();
}

export interface ReportCandidate {
  readonly id: string;
  readonly assetPath: string | null;
  readonly detectorId: string;
  readonly title: string;
  readonly severity: number;
  readonly confidence: number;
  readonly status: FindingStatus;
  readonly lastDetectedMs: number;
  /** 기본 선택: 열린 심각도 2 이상 또는 효과 확인(verified) */
  readonly defaultSelected: boolean;
}

/** 기간에 탐지 창이 겹치거나 기간 안에 탐지된 사이트 발견사항 */
export async function listReportCandidates(siteId: number, period: Pick<PackPeriod, 'from' | 'to'>): Promise<readonly ReportCandidate[]> {
  const from = new Date(period.from);
  const to = new Date(period.to);
  const rows = await db
    .selectFrom('om.finding as f')
    .leftJoin('om.asset as a', 'a.id', 'f.asset_id')
    .select(['f.id', 'a.path', 'f.detector_id', 'f.title', 'f.severity', 'f.confidence', 'f.status', 'f.last_detected_at'])
    .where('f.site_id', '=', siteId)
    .where((eb) => eb.or([eb.and([eb('f.window_end', '>=', from), eb('f.window_start', '<', to)]), eb.and([eb('f.last_detected_at', '>=', from), eb('f.last_detected_at', '<', to)])]))
    .orderBy('f.severity', 'desc')
    .orderBy('f.id')
    .limit(200)
    .execute();
  return rows.flatMap((r): ReportCandidate[] => {
    if (!isFindingStatus(r.status)) return [];
    const open = r.status !== 'dismissed' && r.status !== 'verified';
    return [{ id: r.id, assetPath: r.path, detectorId: r.detector_id, title: r.title, severity: r.severity, confidence: r.confidence, status: r.status, lastDetectedMs: r.last_detected_at.getTime(), defaultSelected: (open && r.severity >= DEFAULT_MIN_SEVERITY) || r.status === 'verified' }];
  });
}

export interface ReportDetail {
  readonly id: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly status: string;
  readonly composerId: string;
  readonly packHash: string;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly approvedBy: string | null;
  readonly approvedAtMs: number | null;
  /** 형식을 읽을 수 없으면 null */
  readonly draft: ReviewDraft | null;
  readonly pack: EvidencePack | null;
  readonly validation: StoredValidationView;
  readonly chain: readonly Readonly<{ id: string; status: string; createdAtMs: number; approvedAtMs: number | null }>[];
}

export async function getReportDetail(reportId: string): Promise<ReportDetail | null> {
  const row = await db
    .selectFrom('om.report as r')
    .innerJoin('om.site as s', 's.id', 'r.site_id')
    .select(['r.id', 'r.site_id', 'r.period', 's.code', 's.name', 'r.status', 'r.composer_id', 'r.pack_hash', 'r.created_by', 'r.created_at', 'r.approved_by', 'r.approved_at', 'r.draft', 'r.pack', 'r.validation'])
    .where('r.id', '=', reportId)
    .executeTakeFirst();
  if (!row) return null;
  const chain = await db
    .selectFrom('om.report')
    .select(['id', 'status', 'created_at', 'approved_at'])
    .where('site_id', '=', row.site_id)
    .where('period', '=', sql<string>`${row.period}::tstzrange`)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return {
    id: row.id,
    siteCode: row.code,
    siteName: row.name,
    status: row.status,
    composerId: row.composer_id,
    packHash: row.pack_hash,
    createdBy: row.created_by,
    createdAtMs: row.created_at.getTime(),
    approvedBy: row.approved_by,
    approvedAtMs: row.approved_at ? row.approved_at.getTime() : null,
    draft: parseReviewDraft(row.draft),
    pack: readStoredPack(row.pack),
    validation: parseStoredValidation(row.validation),
    chain: chain.map((c) => ({ id: c.id, status: c.status, createdAtMs: c.created_at.getTime(), approvedAtMs: c.approved_at ? c.approved_at.getTime() : null })),
  };
}
