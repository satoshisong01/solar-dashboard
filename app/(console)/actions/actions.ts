'use server';

import { revalidatePath } from 'next/cache';
import { AnalysisBusyError, runAnalysis } from '@/lib/analysis/run';
import { registerMaintenanceAction, TransitionError } from '@/lib/analysis/transitions';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { verificationMetricsFor } from '@/lib/desk/action-defaults';
import { verdictLabel } from '@/lib/desk/labels';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseActionIdForm, parseDirectActionForm } from '@/lib/forms/maintenance';
import { ACTION_CSV_MAX_CHARS, type ActionCsvResult } from '@/lib/maintenance/action-csv';
import { parseExpectedEffect } from '@/lib/maintenance/progress';
import { applyActionCsvRows, checkActionCsvText } from '@/lib/maintenance/store';

const DAY_MS = 86_400_000;
const CLOSED: readonly string[] = ['verified', 'dismissed'];

export type DirectActionData = Readonly<{ actionId: string }>;

/** 조치 직접 등록: 설비는 사이트 소속, 발견사항은 같은 사이트·설비의 열린 건만. 검증 지표는 설비 종류로 서버가 다시 거른다 */
export async function recordDirectActionAction(prev: ActionState<DirectActionData>, formData: FormData): Promise<ActionState<DirectActionData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const assetId = /^[1-9]\d{0,9}$/.test(values.assetId ?? '') ? Number(values.assetId) : 0;
  const asset = await db.selectFrom('om.asset').select(['id', 'site_id', 'class_key']).where('id', '=', assetId).executeTakeFirst();
  const parsed = parseDirectActionForm(values, { nowMs: Date.now(), allowedMetrics: verificationMetricsFor(asset?.class_key ?? null).map((m) => m.key) });
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const input = parsed.input;
  if (!asset || asset.site_id !== input.siteId) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: { assetId: '고른 사이트의 설비가 아닙니다' } });
  if (input.findingId !== null) {
    const finding = await db.selectFrom('om.finding').select(['site_id', 'asset_id', 'status']).where('id', '=', input.findingId).executeTakeFirst();
    if (!finding || finding.site_id !== input.siteId || (finding.asset_id !== null && finding.asset_id !== asset.id)) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: { findingId: '고른 설비의 발견사항이 아닙니다' } });
    if (CLOSED.includes(finding.status)) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: { findingId: '닫힌 발견사항에는 연결할 수 없습니다. 분석 데스크에서 먼저 다시 여세요' } });
  }
  try {
    const result = await registerMaintenanceAction(db, { ...input, source: 'manual', actor: session.user.email });
    revalidatePath('/', 'layout');
    const suffix = input.expectedEffect ? ' 안정화 기간과 비교 창이 지난 뒤 분석을 실행하면 효과를 검증합니다.' : ' 기대 효과가 없어 자동 검증은 하지 않습니다.';
    return successState(prev, `조치 #${result.actionId}을(를) 등록했습니다.${suffix}`, { actionId: result.actionId });
  } catch (error) {
    if (error instanceof TransitionError) return errorState(prev, error.message, { values });
    console.error('[actions/record] 조치 등록 실패:', error);
    return errorState(prev, '조치를 등록하지 못했습니다. 잠시 뒤 다시 시도하세요.', { values });
  }
}

export type CsvPreviewData = Readonly<{ result: ActionCsvResult; applied: boolean; inserted: number; transitioned: number }>;

function csvText(formData: FormData): string | null {
  const csv = formData.get('csv');
  return typeof csv === 'string' && csv.length > 0 && csv.length <= ACTION_CSV_MAX_CHARS ? csv : null;
}

/** CSV 미리보기: 사이트·설비·발견사항·중복을 DB와 대조해 행별 오류를 돌려준다 (저장하지 않음) */
export async function previewActionCsvAction(prev: ActionState<CsvPreviewData>, formData: FormData): Promise<ActionState<CsvPreviewData>> {
  await requireAdmin();
  const csv = csvText(formData);
  if (csv === null) return errorState(prev, `CSV 내용이 없거나 너무 큽니다 (최대 ${ACTION_CSV_MAX_CHARS.toLocaleString('ko-KR')}자).`);
  const result = await checkActionCsvText(db, csv, Date.now());
  return successState(prev, result.errorCount > 0 ? `검증 오류 ${result.errorCount}건이 있습니다. 고친 뒤 파일을 다시 고르세요.` : `${result.rows.length}행을 가져올 수 있습니다.`, { result, applied: false, inserted: 0, transitioned: 0 });
}

/** CSV 적용: 미리보기를 믿지 않고 다시 검증하고, 오류가 한 행이라도 있으면 아무것도 넣지 않는다 (한 트랜잭션) */
export async function applyActionCsvAction(prev: ActionState<CsvPreviewData>, formData: FormData): Promise<ActionState<CsvPreviewData>> {
  const session = await requireAdmin();
  const csv = csvText(formData);
  if (csv === null) return errorState(prev, 'CSV 내용이 없습니다. 파일을 다시 고르세요.');
  try {
    const result = await checkActionCsvText(db, csv, Date.now());
    if (result.errorCount > 0) return errorState(prev, `검증 오류 ${result.errorCount}건이 있어 적용하지 않았습니다. 첫 오류: ${result.errors[0]?.line}행 ${result.errors[0]?.message}`);
    const applied = await applyActionCsvRows(db, result.rows, session.user.email);
    revalidatePath('/', 'layout');
    const duplicates = applied.duplicates > 0 ? ` 그 사이 같은 조치가 이미 등록된 ${applied.duplicates}건은 건너뛰었습니다.` : '';
    return successState(prev, `조치 ${applied.inserted}건을 가져왔습니다.${duplicates} 연결 발견사항 ${applied.transitioned}건을 조치 완료로 옮겼고, 기대 효과가 채워진 ${applied.withExpectedEffect}건은 분석 실행 때 효과를 검증합니다.`, { result, applied: true, inserted: applied.inserted, transitioned: applied.transitioned });
  } catch (error) {
    if (error instanceof TransitionError) return errorState(prev, error.message);
    console.error('[actions/csv] CSV 적용 실패:', error);
    return errorState(prev, 'CSV를 적용하지 못했습니다. 아무 행도 저장하지 않았습니다.');
  }
}

export type VerifyOnlyData = Readonly<{ runId: string; verdict: string | null }>;

/** 검증만 실행: 이 조치 설비만, 저장된 에피소드로 조치 효과 검증 단계만 부른다 (runAnalysis stages='verify') */
export async function verifyOnlyAction(prev: ActionState<VerifyOnlyData>, formData: FormData): Promise<ActionState<VerifyOnlyData>> {
  const session = await requireAdmin();
  const parsed = parseActionIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE);
  const action = await db.selectFrom('om.maintenance_action').select(['id', 'site_id', 'asset_id', 'performed_at', 'expected_effect']).where('id', '=', parsed.input.actionId).executeTakeFirst();
  if (!action) return errorState(prev, '조치를 찾을 수 없습니다.');
  const effect = parseExpectedEffect(action.expected_effect);
  if (!effect) return errorState(prev, '기대 효과가 없는 조치는 검증하지 않습니다.');
  const now = new Date();
  const from = new Date(Math.min(action.performed_at.getTime() - effect.windowDays * DAY_MS, now.getTime() - DAY_MS));
  try {
    const result = await runAnalysis(db, { siteIds: [action.site_id], assetIds: [action.asset_id], from, to: now, requestedBy: session.user.email }, { stages: 'verify' });
    revalidatePath('/', 'layout');
    if (result.status === 'failed') return errorState(prev, `검증 실행 #${result.runId}이(가) 실패했습니다: ${result.stats.errors[0]?.message ?? ''}`);
    const verification = await db.selectFrom('om.action_verification').select(['verdict', 'run_id']).where('action_id', '=', action.id).orderBy('computed_at', 'desc').executeTakeFirst();
    const verdict = verification?.run_id === result.runId ? verification.verdict : null;
    const message = verdict ? `검증 실행 #${result.runId}: ${verdictLabel(verdict)}.` : `검증 실행 #${result.runId}: 후 창이 아직 채워지지 않아 판정하지 않았습니다.`;
    return successState(prev, message, { runId: result.runId, verdict });
  } catch (error) {
    if (error instanceof AnalysisBusyError) return errorState(prev, error.message);
    console.error('[actions/verify] 검증만 실행 실패:', error);
    return errorState(prev, '검증을 실행하지 못했습니다. 잠시 뒤 다시 시도하세요.');
  }
}
