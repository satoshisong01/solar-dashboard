'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { TransitionError } from '@/lib/analysis/transitions';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseBlockInclusionForm, parseBlockTextForm, parseCreateReportForm, parseReportIdForm } from '@/lib/forms/reports';
import { approveReport, createReport, editReportBlock, regenerateReport, ReportError, setReportBlockInclusion, type StoredValidation } from '@/lib/report/service';

const knownError = (error: unknown): string | null => (error instanceof ReportError || error instanceof TransitionError ? error.message : null);

/** 리포트 만들기 (설계 §0: 분석 실행과 분리 — 분석을 부르지 않고 저장된 발견사항·KPI로 초안만 만든다). 성공하면 검토 화면으로 */
export async function createReportAction(prev: ActionState<null>, formData: FormData): Promise<ActionState<null>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseCreateReportForm(values, formData.getAll('findingId'));
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  let reportId: string;
  try {
    const result = await createReport(db, { ...parsed.input, actor: session.user.email, now: new Date() });
    reportId = result.reportId;
  } catch (error) {
    const message = knownError(error);
    if (message) return errorState(prev, message, { values });
    console.error('[reports/create] 리포트 만들기 실패:', error);
    return errorState(prev, '리포트를 만들지 못했습니다. 잠시 뒤 다시 시도하세요.', { values });
  }
  revalidatePath('/reports');
  redirect(`/reports/${reportId}`);
}

export type ReviewResultData = Readonly<{ validationOk: boolean; issueCount: number }>;

async function review(prev: ActionState<ReviewResultData>, reportId: string, run: () => Promise<StoredValidation>, done: string): Promise<ActionState<ReviewResultData>> {
  try {
    const validation = await run();
    revalidatePath(`/reports/${reportId}`);
    revalidatePath('/reports');
    const note = validation.ok ? ' 검증을 통과했습니다.' : ` 검증 문제 ${validation.issues.length}건이 남았습니다.`;
    return successState(prev, `${done}${note}`, { validationOk: validation.ok, issueCount: validation.issues.length });
  } catch (error) {
    const message = knownError(error);
    if (message) return errorState(prev, message);
    console.error('[reports/review] 검토 저장 실패:', error);
    return errorState(prev, '저장하지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요.');
  }
}

/** 블록 문장 편집 (숫자 토큰 잠금: 서버에서도 보존을 다시 검사한다) */
export async function saveReportBlockAction(prev: ActionState<ReviewResultData>, formData: FormData): Promise<ActionState<ReviewResultData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseBlockTextForm(values);
  if (!parsed.ok) return errorState(prev, parsed.fieldErrors.text ?? INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const { reportId, blockId, text } = parsed.input;
  return review(prev, reportId, () => editReportBlock(db, { reportId, blockId, text, actor: session.user.email, now: new Date() }), '문장을 저장했습니다.');
}

/** 블록 포함/제외 (제외 사유 필수) */
export async function setReportBlockInclusionAction(prev: ActionState<ReviewResultData>, formData: FormData): Promise<ActionState<ReviewResultData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseBlockInclusionForm(values);
  if (!parsed.ok) return errorState(prev, parsed.fieldErrors.reason ?? INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const { reportId, blockId, included, reason } = parsed.input;
  return review(prev, reportId, () => setReportBlockInclusion(db, { reportId, blockId, included, reason, actor: session.user.email, now: new Date() }), included ? '블록을 다시 포함했습니다.' : '블록을 제외했습니다.');
}

/** 승인: 검증 통과한 초안만. 포함한 발견사항은 리포트 반영(in_report), 같은 기간 이전 리포트는 대체됨.
 *  승인하면 승인 폼이 사라지므로 결과는 검토 화면 쿼리(approved·superseded)로 알린다 */
export async function approveReportAction(prev: ActionState<null>, formData: FormData): Promise<ActionState<null>> {
  const session = await requireAdmin();
  const parsed = parseReportIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE);
  const { reportId } = parsed.input;
  let query: string;
  try {
    const result = await approveReport(db, { reportId, actor: session.user.email, now: new Date() });
    query = `approved=${result.moved.length}&superseded=${result.superseded}`;
  } catch (error) {
    const message = knownError(error);
    if (message) return errorState(prev, message);
    console.error('[reports/approve] 승인 실패:', error);
    return errorState(prev, '승인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
  }
  revalidatePath('/', 'layout');
  redirect(`/reports/${reportId}?${query}`);
}

/** 승인·대체된 리포트에서 같은 사이트·기간·선택으로 새 초안 만들기 */
export async function regenerateReportAction(prev: ActionState<null>, formData: FormData): Promise<ActionState<null>> {
  const session = await requireAdmin();
  const parsed = parseReportIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE);
  let reportId: string;
  try {
    reportId = (await regenerateReport(db, { reportId: parsed.input.reportId, actor: session.user.email, now: new Date() })).reportId;
  } catch (error) {
    const message = knownError(error);
    if (message) return errorState(prev, message);
    console.error('[reports/regenerate] 새 초안 실패:', error);
    return errorState(prev, '새 초안을 만들지 못했습니다. 잠시 뒤 다시 시도하세요.');
  }
  revalidatePath('/reports');
  redirect(`/reports/${reportId}`);
}
