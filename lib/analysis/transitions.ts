// finding 상태 전이 서비스 (DB). 규칙은 transition-rules.ts, 호출 전 관리자 확인(requireAdmin)은 Server Action이 한다.
// 모든 전이는 finding 행을 잠근 트랜잭션에서 상태 변경 + finding_transition 기록을 함께 한다.
import type { Kysely, Transaction } from 'kysely';
import * as z from 'zod';
import type { DB } from '@/lib/db/types';
import { checkTransition, isFindingStatus, OPERATING_CONDITION_CHANGE, SYSTEM_ACTOR, type FindingStatus, type TransitionAction } from './transition-rules';

export type TransitionErrorCode = 'not_found' | 'invalid' | 'conflict';

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface TransitionResult {
  readonly findingId: string;
  readonly from: FindingStatus;
  readonly to: FindingStatus;
}

interface TransitionOptions {
  readonly note?: string | null;
  readonly reason?: string | null;
  readonly suppressedUntil?: Date | null;
}

const requireActor = (actor: string): string => {
  if (actor.trim() === '') throw new TransitionError('invalid', '행위자(관리자 이메일 또는 system)가 필요합니다');
  return actor;
};

/** 잠근 finding 한 건을 전이한다. 트랜잭션 안에서 호출한다 */
export async function applyTransition(trx: Transaction<DB>, findingId: string, action: TransitionAction, actor: string, options: TransitionOptions = {}): Promise<TransitionResult> {
  const row = await trx.selectFrom('om.finding').select(['id', 'status', 'dedup_key']).where('id', '=', findingId).forUpdate().executeTakeFirst();
  if (!row || !isFindingStatus(row.status)) throw new TransitionError('not_found', `발견사항 ${findingId}을(를) 찾을 수 없습니다`);
  const check = checkTransition(action, row.status, requireActor(actor), options.reason);
  if (!check.ok) throw new TransitionError('invalid', check.reason);
  if (action === 'reopen') {
    const open = await trx.selectFrom('om.finding').select('id').where('dedup_key', '=', row.dedup_key).where('id', '<>', row.id).where('status', 'not in', ['verified', 'dismissed']).executeTakeFirst();
    if (open) throw new TransitionError('conflict', `같은 문제의 열린 발견사항(${open.id})이 있어 다시 열 수 없습니다`);
  }
  await trx
    .updateTable('om.finding')
    .set({
      status: check.to,
      updated_at: new Date(),
      ...(action === 'dismiss' ? { dismiss_reason: options.reason?.trim() ?? null, suppressed_until: options.suppressedUntil ?? null } : {}),
      ...(action === 'reopen' ? { suppressed_until: null } : {}),
    })
    .where('id', '=', row.id)
    .execute();
  await trx.insertInto('om.finding_transition').values({ finding_id: row.id, from_status: row.status, to_status: check.to, actor, note: options.note ?? null }).execute();
  return { findingId: row.id, from: row.status, to: check.to };
}

export async function triageFinding(db: Kysely<DB>, input: { findingId: string; actor: string; note?: string | null }): Promise<TransitionResult> {
  return db.transaction().execute((trx) => applyTransition(trx, input.findingId, 'triage', input.actor, { note: input.note }));
}

export interface DismissInput {
  readonly findingId: string;
  readonly actor: string;
  readonly reason: string;
  readonly note?: string | null;
  /** 이 기간 동안 같은 문제를 다시 탐지해도 새 발견사항을 만들지 않는다 (기본 30일, 0이면 억제 없음) */
  readonly suppressDays?: number;
  /** 사유가 '운영 조건 변경'일 때만: 이 시각에 기준선을 나누는 asset_event(resets_baseline)를 만든다 */
  readonly resetBaseline?: { readonly ts: Date; readonly kind?: 'setpoint_change' | 'replacement' | 'firmware' | 'calibration' | 'maintenance' | 'other' } | null;
  readonly now?: Date;
}

const MAX_SUPPRESS_DAYS = 365;

export async function dismissFinding(db: Kysely<DB>, input: DismissInput): Promise<TransitionResult & { readonly assetEventId: string | null }> {
  const suppressDays = input.suppressDays ?? 30;
  if (!Number.isInteger(suppressDays) || suppressDays < 0 || suppressDays > MAX_SUPPRESS_DAYS) throw new TransitionError('invalid', `억제 기간은 0~${MAX_SUPPRESS_DAYS}일 정수여야 합니다`);
  if (input.resetBaseline && input.reason.trim() !== OPERATING_CONDITION_CHANGE) throw new TransitionError('invalid', `기준선 분할은 기각 사유가 '${OPERATING_CONDITION_CHANGE}'일 때만 만들 수 있습니다`);
  const now = input.now ?? new Date();
  return db.transaction().execute(async (trx) => {
    const suppressedUntil = suppressDays === 0 ? null : new Date(now.getTime() + suppressDays * 86_400_000);
    const result = await applyTransition(trx, input.findingId, 'dismiss', input.actor, { reason: input.reason, note: input.note, suppressedUntil });
    if (!input.resetBaseline) return { ...result, assetEventId: null };
    const finding = await trx.selectFrom('om.finding').select(['asset_id', 'title']).where('id', '=', input.findingId).executeTakeFirstOrThrow();
    if (finding.asset_id === null) throw new TransitionError('invalid', '사이트 단위 발견사항에는 설비 기준선 분할을 만들 수 없습니다');
    const event = await trx
      .insertInto('om.asset_event')
      .values({ asset_id: finding.asset_id, ts: input.resetBaseline.ts, kind: input.resetBaseline.kind ?? 'setpoint_change', resets_baseline: true, note: `기각(${OPERATING_CONDITION_CHANGE}): ${finding.title}`, created_by: input.actor })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { ...result, assetEventId: event.id };
  });
}

export async function reopenFinding(db: Kysely<DB>, input: { findingId: string; actor: string; note?: string | null }): Promise<TransitionResult> {
  return db.transaction().execute((trx) => applyTransition(trx, input.findingId, 'reopen', input.actor, { note: input.note }));
}

/** 리포트 승인 시: 승인한 리포트가 인용한 발견사항을 in_report로. 이미 그 뒤 단계거나 닫힌 건은 건너뛴다 */
export async function markFindingsInReport(db: Kysely<DB>, input: { findingIds: readonly string[]; actor: string; note?: string | null }): Promise<{ readonly moved: readonly string[]; readonly skipped: readonly string[] }> {
  return db.transaction().execute(async (trx) => {
    const moved: string[] = [];
    const skipped: string[] = [];
    for (const findingId of [...new Set(input.findingIds)].sort()) {
      try {
        moved.push((await applyTransition(trx, findingId, 'report', input.actor, { note: input.note })).findingId);
      } catch (error) {
        if (!(error instanceof TransitionError) || error.code === 'not_found') throw error;
        skipped.push(findingId);
      }
    }
    return { moved, skipped };
  });
}

export const expectedEffectSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(['increase', 'decrease']),
  min_delta: z.number().nonnegative(),
  stabilization_days: z.number().int().min(0).max(90),
  /** 전후 비교 창 길이 [일] (선택, 기본 30) */
  window_days: z.number().int().min(1).max(180).optional(),
});
export type ExpectedEffect = z.infer<typeof expectedEffectSchema>;

export interface MaintenanceActionInput {
  readonly siteId: number;
  readonly assetId: number;
  readonly findingId: string | null;
  readonly actionType: string;
  readonly performedAt: Date;
  readonly performedBy?: string | null;
  readonly notes?: string | null;
  readonly expectedEffect: ExpectedEffect | null;
  readonly source: 'manual' | 'csv';
  readonly actor: string;
}

/** 정비 조치를 기록하고, 발견사항과 연결했으면 action_taken으로 옮긴다 (이미 action_taken이면 그대로) */
export async function registerMaintenanceAction(db: Kysely<DB>, input: MaintenanceActionInput): Promise<{ readonly actionId: string; readonly transition: TransitionResult | null }> {
  const effect = input.expectedEffect === null ? null : expectedEffectSchema.parse(input.expectedEffect);
  if (input.actionType.trim() === '') throw new TransitionError('invalid', '조치 종류를 입력하세요');
  return db.transaction().execute(async (trx) => {
    const asset = await trx.selectFrom('om.asset').select('id').where('id', '=', input.assetId).where('site_id', '=', input.siteId).executeTakeFirst();
    if (!asset) throw new TransitionError('invalid', '사이트에 없는 설비입니다');
    const action = await trx
      .insertInto('om.maintenance_action')
      .values({ site_id: input.siteId, asset_id: input.assetId, finding_id: input.findingId, action_type: input.actionType.trim(), performed_at: input.performedAt, performed_by: input.performedBy ?? null, notes: input.notes ?? null, expected_effect: effect === null ? null : JSON.stringify(effect), source: input.source, created_by: requireActor(input.actor) })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (input.findingId === null) return { actionId: action.id, transition: null };
    const current = await trx.selectFrom('om.finding').select('status').where('id', '=', input.findingId).executeTakeFirst();
    if (!current) throw new TransitionError('not_found', `발견사항 ${input.findingId}을(를) 찾을 수 없습니다`);
    if (current.status === 'action_taken') return { actionId: action.id, transition: null };
    return { actionId: action.id, transition: await applyTransition(trx, input.findingId, 'action', input.actor, { note: `조치 기록: ${input.actionType.trim()}` }) };
  });
}

/** 조치 효과 검증이 개선을 확인하면 system이 verified로 옮긴다 (action_taken일 때만) */
export async function verifyFindingBySystem(trx: Transaction<DB>, findingId: string, note: string): Promise<TransitionResult | null> {
  const row = await trx.selectFrom('om.finding').select('status').where('id', '=', findingId).executeTakeFirst();
  if (!row || row.status !== 'action_taken') return null;
  return applyTransition(trx, findingId, 'verify', SYSTEM_ACTOR, { note });
}

