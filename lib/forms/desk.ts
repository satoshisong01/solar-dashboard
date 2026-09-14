// 분석 데스크 폼 검증: 분석 실행 · 발견사항 선택 · 기각 · 조치 기록. 서버 전용 (zod). 시각 입력은 KST datetime-local.
import * as z from 'zod';
import { MAX_ANALYSIS_DAYS } from '@/lib/analysis/run';
import { OPERATING_CONDITION_CHANGE } from '@/lib/analysis/transition-rules';
import { fromKstInputValue } from '@/lib/data/range';
import { DEFAULT_SUPPRESS_DAYS, DISMISS_REASONS, MAX_SUPPRESS_DAYS } from '@/lib/desk/labels';
import { fieldErrorsOf, type FieldErrors, type FormValues } from './action-state';
import { idField, pickFields, SMALLINT_MAX } from './fields';
import { ACTION_FUTURE_DAYS_MAX, ACTION_NOTE_MAX, ACTION_TYPE_MAX, ANALYSIS_PERIOD_DAYS, BULK_FINDINGS_MAX, DISMISS_NOTE_MAX, PERFORMED_BY_MAX } from './limits';

export type ParseResult<T> = Readonly<{ ok: true; input: T }> | Readonly<{ ok: false; fieldErrors: FieldErrors }>;

const DAY_MS = 86_400_000;
const BIGINT_ID = /^[1-9]\d{0,17}$/;
const OTHER_REASON = '기타';

export function parseWith<T>(schema: z.ZodType<T>, values: unknown): ParseResult<T> {
  const result = schema.safeParse(values);
  return result.success ? { ok: true, input: result.data } : { ok: false, fieldErrors: fieldErrorsOf(result.error) };
}

export const kstDateTime = (message: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      const ms = fromKstInputValue(value);
      if (ms !== null) return ms;
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    });

export const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}은(는) ${max}자 이하입니다`)
    .transform((value) => (value === '' ? null : value));

// ── 분석 실행 ────────────────────────────────────────────────

export interface RunFormInput {
  readonly siteIds: readonly number[];
  readonly assetIds: readonly number[] | undefined;
  readonly from: Date;
  readonly to: Date;
}

const PERIODS: readonly string[] = [...ANALYSIS_PERIOD_DAYS.map(String), 'custom'];

/** 사이트(여러 개)·설비(선택, 여러 개)·기간(최근 N일 또는 사용자 지정). 사용자 지정 끝이 지금보다 늦으면 지금으로 맞춘다 */
export function parseRunForm(input: Readonly<{ values: FormValues; siteIds: readonly string[]; assetIds: readonly string[]; nowMs: number }>): ParseResult<RunFormInput> {
  const schema = z
    .object({
      siteIds: z.array(idField('사이트가 올바르지 않습니다', SMALLINT_MAX)).min(1, '사이트를 하나 이상 고르세요'),
      assetIds: z.array(idField('설비가 올바르지 않습니다')),
      period: z.string().refine((value) => PERIODS.includes(value), '기간을 고르세요'),
      from: z.string(),
      to: z.string(),
    })
    .transform((v, ctx) => {
      const unique = <T>(items: readonly T[]) => [...new Set(items)];
      if (v.period !== 'custom') {
        return { siteIds: unique(v.siteIds), assetIds: v.assetIds.length > 0 ? unique(v.assetIds) : undefined, from: new Date(input.nowMs - Number(v.period) * DAY_MS), to: new Date(input.nowMs) };
      }
      const from = fromKstInputValue(v.from.trim());
      const rawTo = fromKstInputValue(v.to.trim());
      if (from === null) ctx.addIssue({ code: 'custom', path: ['from'], message: '시작 시각을 입력하세요' });
      if (rawTo === null) ctx.addIssue({ code: 'custom', path: ['to'], message: '끝 시각을 입력하세요' });
      if (from === null || rawTo === null) return z.NEVER;
      const to = Math.min(rawTo, input.nowMs);
      if (to <= from) ctx.addIssue({ code: 'custom', path: ['to'], message: '끝 시각은 시작 시각보다 늦고 지금 이전이어야 합니다' });
      else if (to - from > MAX_ANALYSIS_DAYS * DAY_MS) ctx.addIssue({ code: 'custom', path: ['from'], message: `분석 기간은 ${MAX_ANALYSIS_DAYS}일 이하여야 합니다` });
      return { siteIds: unique(v.siteIds), assetIds: v.assetIds.length > 0 ? unique(v.assetIds) : undefined, from: new Date(from), to: new Date(to) };
    });
  return parseWith(schema, { ...pickFields(input.values, ['period', 'from', 'to']), siteIds: [...input.siteIds], assetIds: [...input.assetIds] });
}

// ── 발견사항 선택 (일괄 분류·기각) ───────────────────────────

export function parseFindingIds(raw: readonly FormDataEntryValue[]): ParseResult<readonly string[]> {
  const ids = raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim());
  if (ids.length === 0) return { ok: false, fieldErrors: { findingId: '발견사항을 하나 이상 고르세요' } };
  if (ids.some((id) => !BIGINT_ID.test(id))) return { ok: false, fieldErrors: { findingId: '발견사항이 올바르지 않습니다' } };
  const unique = [...new Set(ids)];
  if (unique.length > BULK_FINDINGS_MAX) return { ok: false, fieldErrors: { findingId: `한 번에 ${BULK_FINDINGS_MAX}건까지 처리할 수 있습니다` } };
  return { ok: true, input: unique };
}

// ── 기각 ────────────────────────────────────────────────────

export interface DismissFormInput {
  readonly reason: string;
  readonly note: string | null;
  readonly suppressDays: number;
  /** 사유가 '운영 조건 변경'이고 체크했을 때만: 기준선을 나눌 시각 */
  readonly resetBaselineAt: Date | null;
}

export function parseDismissForm(values: FormValues, nowMs: number): ParseResult<DismissFormInput> {
  const schema = z
    .object({
      reason: z.string().refine((value) => DISMISS_REASONS.includes(value), '기각 사유를 고르세요'),
      note: optionalText(DISMISS_NOTE_MAX, '메모'),
      suppressDays: z
        .string()
        .trim()
        .transform((value) => (value === '' ? DEFAULT_SUPPRESS_DAYS : Number(value)))
        .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_SUPPRESS_DAYS, `억제 기간은 0~${MAX_SUPPRESS_DAYS}일 정수입니다`),
      resetBaseline: z.string(),
      baselineAt: z.string(),
    })
    .transform((v, ctx) => {
      if (v.reason === OTHER_REASON && v.note === null) ctx.addIssue({ code: 'custom', path: ['note'], message: "사유가 '기타'이면 메모를 입력하세요" });
      const wantsReset = v.resetBaseline === 'on';
      if (wantsReset && v.reason !== OPERATING_CONDITION_CHANGE) ctx.addIssue({ code: 'custom', path: ['resetBaseline'], message: `기준선 분할은 사유가 '${OPERATING_CONDITION_CHANGE}'일 때만 만들 수 있습니다` });
      const at = wantsReset ? fromKstInputValue(v.baselineAt.trim()) : null;
      if (wantsReset && at === null) ctx.addIssue({ code: 'custom', path: ['baselineAt'], message: '운영 조건이 바뀐 시점을 입력하세요' });
      if (at !== null && at > nowMs) ctx.addIssue({ code: 'custom', path: ['baselineAt'], message: '바뀐 시점은 지금 이전이어야 합니다' });
      return { reason: v.reason, note: v.note, suppressDays: v.suppressDays, resetBaselineAt: at === null ? null : new Date(at) };
    });
  return parseWith(schema, pickFields(values, ['reason', 'note', 'suppressDays', 'resetBaseline', 'baselineAt']));
}

// ── 조치 기록 ───────────────────────────────────────────────

export interface ActionFormInput {
  readonly findingId: string;
  readonly actionType: string;
  readonly performedAt: Date;
  readonly performedBy: string | null;
  readonly notes: string | null;
  readonly expectedEffect: { metric: string; direction: 'increase' | 'decrease'; min_delta: number; stabilization_days: number } | null;
}

export const effectFields = z.object({
  effectMetric: z.string().trim(),
  direction: z.string(),
  minDelta: z.string().trim(),
  stabilizationDays: z.string().trim(),
});

export function parseExpectedEffect(v: z.output<typeof effectFields>, allowedMetrics: readonly string[], ctx: z.core.$RefinementCtx): ActionFormInput['expectedEffect'] {
  if (v.effectMetric === '') return null;
  if (!allowedMetrics.includes(v.effectMetric)) ctx.addIssue({ code: 'custom', path: ['effectMetric'], message: '검증 지표가 올바르지 않습니다' });
  if (v.direction !== 'increase' && v.direction !== 'decrease') ctx.addIssue({ code: 'custom', path: ['direction'], message: '기대 방향을 고르세요' });
  const minDelta = /^\d+(\.\d+)?$/.test(v.minDelta) ? Number(v.minDelta) : Number.NaN;
  if (!Number.isFinite(minDelta)) ctx.addIssue({ code: 'custom', path: ['minDelta'], message: '최소 변화량을 0 이상 숫자로 입력하세요' });
  const days = /^\d{1,2}$/.test(v.stabilizationDays) ? Number(v.stabilizationDays) : Number.NaN;
  if (!(days >= 0 && days <= 90)) ctx.addIssue({ code: 'custom', path: ['stabilizationDays'], message: '안정화 일수는 0~90 정수입니다' });
  return { metric: v.effectMetric, direction: v.direction === 'decrease' ? 'decrease' : 'increase', min_delta: minDelta, stabilization_days: days };
}

export function parseActionForm(values: FormValues, input: Readonly<{ nowMs: number; allowedMetrics: readonly string[] }>): ParseResult<ActionFormInput> {
  const baseSchema = z.object({
    findingId: z.string().regex(BIGINT_ID, '발견사항이 올바르지 않습니다'),
    actionType: z.string().trim().min(1, '조치 종류를 입력하세요').max(ACTION_TYPE_MAX, `조치 종류는 ${ACTION_TYPE_MAX}자 이하입니다`),
    performedAt: kstDateTime('수행일시를 입력하세요').refine((ms) => ms <= input.nowMs + ACTION_FUTURE_DAYS_MAX * DAY_MS, `수행 예정일은 ${ACTION_FUTURE_DAYS_MAX}일 이내여야 합니다`),
    performedBy: optionalText(PERFORMED_BY_MAX, '수행자'),
    notes: optionalText(ACTION_NOTE_MAX, '메모'),
  });
  const effectSchema = effectFields.transform((v, ctx) => parseExpectedEffect(v, input.allowedMetrics, ctx));
  // 기본 항목과 기대 효과를 따로 검증해 오류를 한 번에 보여 준다 (zod는 필드 오류가 있으면 transform을 건너뛴다)
  const base = parseWith(baseSchema, pickFields(values, ['findingId', 'actionType', 'performedAt', 'performedBy', 'notes']));
  const effect = parseWith(effectSchema, pickFields(values, ['effectMetric', 'direction', 'minDelta', 'stabilizationDays']));
  if (!base.ok || !effect.ok) return { ok: false, fieldErrors: { ...(effect.ok ? {} : effect.fieldErrors), ...(base.ok ? {} : base.fieldErrors) } };
  return { ok: true, input: { ...base.input, performedAt: new Date(base.input.performedAt), expectedEffect: effect.input } };
}
