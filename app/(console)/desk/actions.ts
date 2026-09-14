'use server';

import { revalidatePath } from 'next/cache';
import { AnalysisBusyError, runAnalysis, type AnalysisStatus } from '@/lib/analysis/run';
import { dismissFinding, reopenFinding, registerMaintenanceAction, TransitionError, triageFinding, type TransitionResult } from '@/lib/analysis/transitions';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { verificationMetricsFor } from '@/lib/desk/action-defaults';
import { summarizeRunStats, type RunSummary } from '@/lib/desk/run-summary';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseActionForm, parseDismissForm, parseFindingIds, parseRunForm } from '@/lib/forms/desk';

/** 화면에서 분석을 실행할 때의 시간 예산. 페이지 maxDuration(800초)보다 짧게 둔다 */
const ACTION_TIME_BUDGET_MS = 10 * 60_000;

export interface RunResultData {
  readonly runId: string;
  readonly status: AnalysisStatus;
  readonly summary: RunSummary;
}

/** 분석 실행 (설계 §0: 수동 실행만, 결과는 발견사항으로만 저장하고 리포트는 만들지 않는다) */
export async function runAnalysisAction(prev: ActionState<RunResultData>, formData: FormData): Promise<ActionState<RunResultData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseRunForm({ values, siteIds: formData.getAll('siteId').map(String), assetIds: formData.getAll('assetId').map(String), nowMs: Date.now() });
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const { siteIds, assetIds, from, to } = parsed.input;

  if (assetIds) {
    const owned = await db.selectFrom('om.asset').select('id').where('id', 'in', [...assetIds]).where('site_id', 'in', [...siteIds]).execute();
    if (owned.length !== assetIds.length) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: { assetIds: '고른 사이트의 설비만 선택할 수 있습니다' } });
  }

  try {
    const result = await runAnalysis(db, { siteIds: [...siteIds], assetIds: assetIds ? [...assetIds] : undefined, from, to, requestedBy: session.user.email }, { timeBudgetMs: ACTION_TIME_BUDGET_MS });
    revalidatePath('/', 'layout');
    const summary = summarizeRunStats(result.stats);
    if (result.status === 'failed') return errorState(prev, `분석 실행 #${result.runId}이(가) 실패했습니다: ${result.stats.errors[0]?.message ?? '원인을 알 수 없습니다'}`, { values });
    const note = result.status === 'partial' ? ' 일부 단계에서 오류가 났거나 시간 예산을 넘었습니다. 실행 이력의 오류를 확인하세요.' : '';
    return successState(prev, `분석 실행 #${result.runId}을(를) 마쳤습니다.${note}`, { runId: result.runId, status: result.status, summary });
  } catch (error) {
    if (error instanceof AnalysisBusyError) return errorState(prev, error.message, { values });
    console.error('[desk/run] 분석 실행 실패:', error);
    return errorState(prev, '분석 중 오류가 났습니다. 저장된 결과는 그대로이며 다시 실행할 수 있습니다.', { values });
  }
}

export interface BulkResultData {
  readonly moved: number;
  readonly skipped: readonly Readonly<{ findingId: string; reason: string }>[];
  readonly baselineEvents: number;
}

type Outcome = Readonly<{ moved: boolean; findingId: string; reason: string | null; baselineEvent: boolean }>;

/** 한 건씩 전이한다. 규칙에 맞지 않는 건(TransitionError)은 건너뛰고 이유를 모은다 */
async function eachFinding(ids: readonly string[], apply: (findingId: string) => Promise<TransitionResult & { readonly assetEventId?: string | null }>): Promise<BulkResultData> {
  const outcomes: Outcome[] = [];
  for (const findingId of ids) {
    try {
      const result = await apply(findingId);
      outcomes.push({ moved: true, findingId, reason: null, baselineEvent: Boolean(result.assetEventId) });
    } catch (error) {
      if (!(error instanceof TransitionError)) throw error;
      outcomes.push({ moved: false, findingId, reason: error.message, baselineEvent: false });
    }
  }
  return {
    moved: outcomes.filter((o) => o.moved).length,
    skipped: outcomes.flatMap((o) => (o.moved ? [] : [{ findingId: o.findingId, reason: o.reason ?? '' }])),
    baselineEvents: outcomes.filter((o) => o.baselineEvent).length,
  };
}

function bulkMessage(verb: string, data: BulkResultData): string {
  const skipped = data.skipped.length > 0 ? ` ${data.skipped.length}건은 건너뛰었습니다.` : '';
  const baseline = data.baselineEvents > 0 ? ` 기준선 분할 이벤트 ${data.baselineEvents}건을 만들었습니다.` : '';
  return `${data.moved}건을 ${verb}.${skipped}${baseline}`;
}

async function runBulk(prev: ActionState<BulkResultData>, verb: string, apply: (findingId: string) => Promise<TransitionResult & { readonly assetEventId?: string | null }>, ids: readonly string[]): Promise<ActionState<BulkResultData>> {
  try {
    const data = await eachFinding(ids, apply);
    revalidatePath('/', 'layout');
    if (data.moved === 0) return errorState(prev, `바꾼 발견사항이 없습니다: ${data.skipped[0]?.reason ?? ''}`);
    return successState(prev, bulkMessage(verb, data), data);
  } catch (error) {
    console.error(`[desk/bulk] ${verb} 실패:`, error);
    return errorState(prev, '처리 중 오류가 났습니다. 목록을 새로 고친 뒤 다시 시도하세요.');
  }
}

/** 일괄 분류: new·reopened → triaged (조사 중) */
export async function triageFindingsAction(prev: ActionState<BulkResultData>, formData: FormData): Promise<ActionState<BulkResultData>> {
  const session = await requireAdmin();
  const ids = parseFindingIds(formData.getAll('findingId'));
  if (!ids.ok) return errorState(prev, ids.fieldErrors.findingId ?? INVALID_FORM_MESSAGE);
  return runBulk(prev, '분류(조사 중)로 옮겼습니다', (findingId) => triageFinding(db, { findingId, actor: session.user.email }), ids.input);
}

/** 일괄 기각: 사유 필수. '운영 조건 변경'이면 선택한 시점에 기준선 분할 이벤트를 함께 만든다 */
export async function dismissFindingsAction(prev: ActionState<BulkResultData>, formData: FormData): Promise<ActionState<BulkResultData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const ids = parseFindingIds(formData.getAll('findingId'));
  if (!ids.ok) return errorState(prev, ids.fieldErrors.findingId ?? INVALID_FORM_MESSAGE, { values });
  const parsed = parseDismissForm(values, Date.now());
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const { reason, note, suppressDays, resetBaselineAt } = parsed.input;
  // 전이 이력에도 사유를 남긴다 (finding.dismiss_reason은 다시 기각하면 덮어쓴다)
  const historyNote = [`사유: ${reason}`, suppressDays > 0 ? `억제 ${suppressDays}일` : null, note].filter((part): part is string => part !== null).join(' · ');
  return runBulk(prev, '기각했습니다', (findingId) => dismissFinding(db, { findingId, actor: session.user.email, reason, note: historyNote, suppressDays, resetBaseline: resetBaselineAt ? { ts: resetBaselineAt } : null }), ids.input);
}

/** 기각·효과 확인된 발견사항을 다시 연다 */
export async function reopenFindingAction(prev: ActionState<BulkResultData>, formData: FormData): Promise<ActionState<BulkResultData>> {
  const session = await requireAdmin();
  const ids = parseFindingIds(formData.getAll('findingId'));
  if (!ids.ok) return errorState(prev, ids.fieldErrors.findingId ?? INVALID_FORM_MESSAGE);
  return runBulk(prev, '다시 열었습니다', (findingId) => reopenFinding(db, { findingId, actor: session.user.email }), ids.input);
}

export type ActionRecordData = Readonly<{ actionId: string; transitioned: boolean }>;

/** 권고 조치 기록 → om.maintenance_action, 발견사항은 action_taken. 사이트·설비는 발견사항에서 읽는다 (폼 값을 믿지 않음) */
export async function recordMaintenanceAction(prev: ActionState<ActionRecordData>, formData: FormData): Promise<ActionState<ActionRecordData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const findingId = /^[1-9]\d{0,17}$/.test(values.findingId ?? '') ? (values.findingId ?? '0') : '0';
  const finding = await db.selectFrom('om.finding as f').leftJoin('om.asset as a', 'a.id', 'f.asset_id').select(['f.site_id', 'f.asset_id', 'a.class_key']).where('f.id', '=', findingId).executeTakeFirst();
  if (!finding) return errorState(prev, '발견사항을 찾을 수 없습니다.', { values });
  if (finding.asset_id === null) return errorState(prev, '사이트 단위 발견사항에는 설비 조치를 기록할 수 없습니다.', { values });
  // 검증 지표는 이 설비 종류의 에피소드로 계산할 수 있는 것만 받는다
  const allowedMetrics = verificationMetricsFor(finding.class_key).map((metric) => metric.key);
  const parsed = parseActionForm(values, { nowMs: Date.now(), allowedMetrics });
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const input = parsed.input;

  try {
    const result = await registerMaintenanceAction(db, { siteId: finding.site_id, assetId: finding.asset_id, findingId: input.findingId, actionType: input.actionType, performedAt: input.performedAt, performedBy: input.performedBy, notes: input.notes, expectedEffect: input.expectedEffect, source: 'manual', actor: session.user.email });
    revalidatePath('/', 'layout');
    const suffix = input.expectedEffect ? ' 안정화 기간과 비교 창이 지난 뒤 분석을 실행하면 효과를 검증합니다.' : ' 기대 효과가 없어 자동 검증은 하지 않습니다.';
    return successState(prev, `조치를 기록했습니다.${suffix}`, { actionId: result.actionId, transitioned: result.transition !== null });
  } catch (error) {
    if (error instanceof TransitionError) return errorState(prev, error.message, { values });
    console.error('[desk/action] 조치 기록 실패:', error);
    return errorState(prev, '조치를 기록하지 못했습니다. 잠시 뒤 다시 시도하세요.', { values });
  }
}
