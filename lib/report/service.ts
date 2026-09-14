// 리포트 저장·검토·승인 서비스 (DB). 설계 §0: 분석과 분리 — 관리자가 "리포트 만들기"를 눌렀을 때만 만든다(분석 실행을 부르지 않는다).
//   만들기: 팩 조회 → EvidencePack → templateComposer → validateDraft → om.report(draft). 같은 사이트·기간·composer·팩이면 기존 행
//   검토: 초안(draft) 행을 잠그고 문장 편집·블록 포함/제외 → 다시 검증해 저장
//   승인: 검증 통과한 초안만. 같은 사이트·기간의 이전 초안·승인본은 superseded, 포함한 발견사항은 in_report (한 트랜잭션)
import { sql, type Kysely, type Transaction } from 'kysely';
import { markFindingsInReportInTransaction } from '@/lib/analysis/transitions';
import type { DB } from '@/lib/db/types';
import { parseStoredValidation } from './citations';
import { buildEvidencePack, readStoredPack } from './evidence-pack';
import { loadPackInput, ReportError, type ReportRequest } from './load';
import type { EvidencePack } from './pack-types';
import { periodRangeLiteral } from './period';
import { editBlockText, parseReviewDraft, reportedFindingIds, setBlockInclusion, toReviewDraft, type ReviewDraft, type ReviewResult } from './review';
import { templateComposer } from './template-composer';
import { validateDraft, type ValidationResult } from './validate';

export { ReportError } from './load';

export interface StoredValidation extends ValidationResult {
  readonly checkedAt: number;
}

const storedValidation = (draft: ReviewDraft, pack: EvidencePack, now: Date): StoredValidation => ({ ...validateDraft(draft, pack), checkedAt: now.getTime() });

export interface CreateReportResult {
  readonly reportId: string;
  /** false면 같은 팩으로 이미 만든 리포트를 돌려준 것 */
  readonly created: boolean;
  readonly status: string;
  readonly validation: ValidationResult;
}

export async function createReport(db: Kysely<DB>, request: ReportRequest & { readonly actor: string; readonly now: Date }): Promise<CreateReportResult> {
  if (request.actor.trim() === '') throw new ReportError('invalid', '작성자가 필요합니다');
  const pack = buildEvidencePack(await loadPackInput(db, request, request.now));
  const draft = toReviewDraft(templateComposer.compose(pack));
  const validation = storedValidation(draft, pack, request.now);
  const inserted = await db
    .insertInto('om.report')
    .values({ site_id: request.siteId, period: periodRangeLiteral(pack.period), composer_id: draft.composerId, pack: JSON.stringify(pack), pack_hash: pack.provenance.packHash, draft: JSON.stringify(draft), validation: JSON.stringify(validation), created_by: request.actor, created_at: request.now })
    .onConflict((oc) => oc.columns(['site_id', 'period', 'composer_id', 'pack_hash']).doNothing())
    .returning(['id', 'status'])
    .executeTakeFirst();
  if (inserted) return { reportId: inserted.id, created: true, status: inserted.status, validation };
  const existing = await db
    .selectFrom('om.report')
    .select(['id', 'status', 'validation'])
    .where('site_id', '=', request.siteId)
    .where('period', '=', sql<string>`${periodRangeLiteral(pack.period)}::tstzrange`)
    .where('composer_id', '=', draft.composerId)
    .where('pack_hash', '=', pack.provenance.packHash)
    .executeTakeFirstOrThrow();
  return { reportId: existing.id, created: false, status: existing.status, validation: parseStoredValidation(existing.validation) };
}

interface LockedReport {
  readonly id: string;
  readonly siteId: number;
  readonly period: string;
  readonly draft: ReviewDraft;
  readonly pack: EvidencePack;
}

async function lockDraft(trx: Transaction<DB>, reportId: string): Promise<LockedReport> {
  const row = await trx.selectFrom('om.report').select(['id', 'site_id', 'period', 'status', 'draft', 'pack']).where('id', '=', reportId).forUpdate().executeTakeFirst();
  if (!row) throw new ReportError('not_found', `리포트 ${reportId}을(를) 찾을 수 없습니다`);
  if (row.status !== 'draft') throw new ReportError('conflict', row.status === 'approved' ? '승인한 리포트는 편집할 수 없습니다. 새 초안을 만드세요' : '대체된 리포트는 편집할 수 없습니다');
  const draft = parseReviewDraft(row.draft);
  const pack = readStoredPack(row.pack);
  if (!draft || !pack) throw new ReportError('invalid', '저장된 리포트 형식을 읽을 수 없습니다. 리포트를 다시 만드세요');
  return { id: row.id, siteId: row.site_id, period: row.period, draft, pack };
}

async function reviseDraft(db: Kysely<DB>, reportId: string, now: Date, change: (draft: ReviewDraft) => ReviewResult): Promise<StoredValidation> {
  return db.transaction().execute(async (trx) => {
    const report = await lockDraft(trx, reportId);
    const result = change(report.draft);
    if (!result.ok) throw new ReportError('invalid', result.error);
    const validation = storedValidation(result.draft, report.pack, now);
    await trx.updateTable('om.report').set({ draft: JSON.stringify(result.draft), validation: JSON.stringify(validation) }).where('id', '=', report.id).execute();
    return validation;
  });
}

export interface BlockEditInput {
  readonly reportId: string;
  readonly blockId: string;
  readonly actor: string;
  readonly now: Date;
}

export function editReportBlock(db: Kysely<DB>, input: BlockEditInput & { readonly text: string }): Promise<StoredValidation> {
  return reviseDraft(db, input.reportId, input.now, (draft) => editBlockText(draft, input.blockId, input.text, input.actor, input.now.getTime()));
}

export function setReportBlockInclusion(db: Kysely<DB>, input: BlockEditInput & { readonly included: boolean; readonly reason: string | null }): Promise<StoredValidation> {
  return reviseDraft(db, input.reportId, input.now, (draft) => setBlockInclusion(draft, input.blockId, input.included, input.reason, input.actor, input.now.getTime()));
}

export interface ApproveResult {
  readonly moved: readonly string[];
  readonly skipped: readonly string[];
  readonly superseded: number;
}

export async function approveReport(db: Kysely<DB>, input: { readonly reportId: string; readonly actor: string; readonly now: Date }): Promise<ApproveResult> {
  if (input.actor.trim() === '') throw new ReportError('invalid', '승인자가 필요합니다');
  return db.transaction().execute(async (trx) => {
    const report = await lockDraft(trx, input.reportId);
    const validation = storedValidation(report.draft, report.pack, input.now);
    if (!validation.ok) {
      await trx.updateTable('om.report').set({ validation: JSON.stringify(validation) }).where('id', '=', report.id).execute();
      throw new ReportError('invalid', `검증 문제 ${validation.issues.length}건을 해결해야 승인할 수 있습니다: ${validation.issues[0]?.message ?? ''}`);
    }
    const superseded = await trx
      .updateTable('om.report')
      .set({ status: 'superseded' })
      .where('site_id', '=', report.siteId)
      .where('period', '=', sql<string>`${report.period}::tstzrange`)
      .where('id', '<>', report.id)
      .where('status', 'in', ['draft', 'approved'])
      .executeTakeFirst();
    await trx.updateTable('om.report').set({ status: 'approved', approved_by: input.actor, approved_at: input.now, validation: JSON.stringify(validation) }).where('id', '=', report.id).execute();
    const marked = await markFindingsInReportInTransaction(trx, { findingIds: reportedFindingIds(report.draft), actor: input.actor, note: `리포트 #${report.id} 승인` });
    return { ...marked, superseded: Number(superseded.numUpdatedRows) };
  });
}

/** 같은 사이트·기간·발견사항 선택으로 새 초안을 만든다 (승인본을 고칠 때). 같은 리포트에서 다시 누르면 앞서 만든 초안을 돌려준다 */
export async function regenerateReport(db: Kysely<DB>, input: { readonly reportId: string; readonly actor: string; readonly now: Date }): Promise<CreateReportResult> {
  const row = await db.selectFrom('om.report').select(['site_id', 'pack']).where('id', '=', input.reportId).executeTakeFirst();
  const pack = row ? readStoredPack(row.pack) : null;
  if (!row || !pack) throw new ReportError('not_found', `리포트 ${input.reportId}을(를) 찾을 수 없습니다`);
  return createReport(db, { siteId: row.site_id, period: pack.period, findingIds: pack.selection.findingIds, includeVerifiedActions: pack.selection.includeVerifiedActions, basedOnReportId: input.reportId, actor: input.actor, now: input.now });
}
