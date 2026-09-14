// 조치 추적 폼 검증: 조치 직접 등록(설비 선택, 발견사항 연결 선택) · 조치 id. 서버 전용 (zod). 기대 효과 규칙은 분석 데스크 조치 폼과 같다.
import * as z from 'zod';
import type { FormValues } from './action-state';
import { effectFields, kstDateTime, optionalText, parseExpectedEffect, parseWith, type ActionFormInput, type ParseResult } from './desk';
import { idField, pickFields, SMALLINT_MAX } from './fields';
import { ACTION_FUTURE_DAYS_MAX, ACTION_NOTE_MAX, ACTION_TYPE_MAX, PERFORMED_BY_MAX } from './limits';

const DAY_MS = 86_400_000;
const BIGINT_ID = /^[1-9]\d{0,17}$/;

export interface DirectActionFormInput {
  readonly siteId: number;
  readonly assetId: number;
  readonly findingId: string | null;
  readonly actionType: string;
  readonly performedAt: Date;
  readonly performedBy: string | null;
  readonly notes: string | null;
  readonly expectedEffect: ActionFormInput['expectedEffect'];
}

/** allowedMetrics: 고른 설비 종류로 계산할 수 있는 검증 지표 (서버가 설비를 조회해 넘긴다) */
export function parseDirectActionForm(values: FormValues, input: Readonly<{ nowMs: number; allowedMetrics: readonly string[] }>): ParseResult<DirectActionFormInput> {
  const baseSchema = z.object({
    siteId: idField('사이트를 고르세요', SMALLINT_MAX),
    assetId: idField('설비를 고르세요'),
    findingId: z
      .string()
      .trim()
      .refine((v) => v === '' || BIGINT_ID.test(v), '발견사항이 올바르지 않습니다')
      .transform((v) => (v === '' ? null : v)),
    actionType: z.string().trim().min(1, '조치 종류를 입력하세요').max(ACTION_TYPE_MAX, `조치 종류는 ${ACTION_TYPE_MAX}자 이하입니다`),
    performedAt: kstDateTime('수행일시를 입력하세요').refine((ms) => ms <= input.nowMs + ACTION_FUTURE_DAYS_MAX * DAY_MS, `수행 예정일은 ${ACTION_FUTURE_DAYS_MAX}일 이내여야 합니다`),
    performedBy: optionalText(PERFORMED_BY_MAX, '수행자'),
    notes: optionalText(ACTION_NOTE_MAX, '메모'),
  });
  const effectSchema = effectFields.transform((v, ctx) => parseExpectedEffect(v, input.allowedMetrics, ctx));
  const base = parseWith(baseSchema, pickFields(values, ['siteId', 'assetId', 'findingId', 'actionType', 'performedAt', 'performedBy', 'notes']));
  const effect = parseWith(effectSchema, pickFields(values, ['effectMetric', 'direction', 'minDelta', 'stabilizationDays']));
  if (!base.ok || !effect.ok) return { ok: false, fieldErrors: { ...(effect.ok ? {} : effect.fieldErrors), ...(base.ok ? {} : base.fieldErrors) } };
  return { ok: true, input: { ...base.input, performedAt: new Date(base.input.performedAt), expectedEffect: effect.input } };
}

export function parseActionIdForm(values: FormValues): ParseResult<{ readonly actionId: string }> {
  return parseWith(z.object({ actionId: z.string().trim().regex(BIGINT_ID, '조치가 올바르지 않습니다') }), pickFields(values, ['actionId']));
}
