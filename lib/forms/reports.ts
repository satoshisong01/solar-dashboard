// 코칭 리포트 폼 검증: 리포트 만들기 · 블록 문장 편집 · 블록 포함/제외 · 리포트 id. 서버 전용 (zod).
import * as z from 'zod';
import { resolveReportPeriod, type PeriodSpec } from '@/lib/report/period';
import type { PackPeriod } from '@/lib/report/pack-types';
import { BLOCK_TEXT_MAX, EXCLUDE_REASON_MAX } from '@/lib/report/review';
import type { FormValues } from './action-state';
import { parseWith, type ParseResult } from './desk';
import { idField, pickFields, SMALLINT_MAX } from './fields';

const BIGINT_ID = /^[1-9]\d{0,17}$/;
const BLOCK_ID = /^[a-z_]+(\.[A-Za-z0-9_]+){1,3}$/;
/** 한 리포트에 넣을 수 있는 발견사항 수 */
export const REPORT_FINDINGS_MAX = 100;

export interface CreateReportFormInput {
  readonly siteId: number;
  readonly period: PackPeriod;
  readonly findingIds: readonly string[];
  readonly includeVerifiedActions: boolean;
}

/** 기간 선택 값 (GET 쿼리·폼 공용): kind=month&month=YYYY-MM · kind=quarter&year&quarter · kind=custom&from&to */
export function periodSpecOf(values: Readonly<Record<string, string | undefined>>): PeriodSpec | null {
  switch (values.kind) {
    case 'month':
      return { kind: 'month', month: values.month ?? '' };
    case 'quarter':
      return { kind: 'quarter', year: /^\d{4}$/.test(values.year ?? '') ? Number(values.year) : Number.NaN, quarter: /^[1-4]$/.test(values.quarter ?? '') ? Number(values.quarter) : Number.NaN };
    case 'custom':
      return { kind: 'custom', from: values.from ?? '', to: values.to ?? '' };
    default:
      return null;
  }
}

export function parseCreateReportForm(values: FormValues, rawFindingIds: readonly FormDataEntryValue[]): ParseResult<CreateReportFormInput> {
  const site = idField('사이트를 고르세요', SMALLINT_MAX).safeParse(values.siteId ?? '');
  const spec = periodSpecOf(values);
  const period = spec ? resolveReportPeriod(spec) : null;
  const ids = rawFindingIds.filter((v): v is string => typeof v === 'string').map((v) => v.trim());
  const errors: Record<string, string> = {
    ...(site.success ? {} : { siteId: '사이트를 고르세요' }),
    ...(period === null ? { kind: '기간 종류를 고르세요' } : period.ok ? {} : { [period.field]: period.error }),
    ...(ids.some((id) => !BIGINT_ID.test(id)) ? { findingId: '발견사항이 올바르지 않습니다' } : new Set(ids).size > REPORT_FINDINGS_MAX ? { findingId: `발견사항은 ${REPORT_FINDINGS_MAX}건까지 넣을 수 있습니다` } : {}),
  };
  if (!site.success || period === null || !period.ok || Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, input: { siteId: site.data, period: period.period, findingIds: [...new Set(ids)], includeVerifiedActions: values.includeVerifiedActions === 'on' } };
}

const reportIdField = z.string().trim().regex(BIGINT_ID, '리포트가 올바르지 않습니다');
const blockIdField = z.string().trim().regex(BLOCK_ID, '블록이 올바르지 않습니다');

export function parseReportIdForm(values: FormValues): ParseResult<{ readonly reportId: string }> {
  return parseWith(z.object({ reportId: reportIdField }), pickFields(values, ['reportId']));
}

export function parseBlockTextForm(values: FormValues): ParseResult<{ readonly reportId: string; readonly blockId: string; readonly text: string }> {
  const schema = z.object({ reportId: reportIdField, blockId: blockIdField, text: z.string().trim().min(1, '문장을 입력하세요').max(BLOCK_TEXT_MAX, `문장은 ${BLOCK_TEXT_MAX}자 이하입니다`) });
  return parseWith(schema, pickFields(values, ['reportId', 'blockId', 'text']));
}

export function parseBlockInclusionForm(values: FormValues): ParseResult<{ readonly reportId: string; readonly blockId: string; readonly included: boolean; readonly reason: string | null }> {
  const schema = z
    .object({ reportId: reportIdField, blockId: blockIdField, included: z.enum(['1', '0'], { error: '포함 여부가 올바르지 않습니다' }), reason: z.string().trim().max(EXCLUDE_REASON_MAX, `제외 사유는 ${EXCLUDE_REASON_MAX}자 이하입니다`) })
    .refine((v) => v.included === '1' || v.reason !== '', { error: '제외 사유를 입력하세요', path: ['reason'] })
    .transform((v) => ({ reportId: v.reportId, blockId: v.blockId, included: v.included === '1', reason: v.reason === '' ? null : v.reason }));
  return parseWith(schema, pickFields(values, ['reportId', 'blockId', 'included', 'reason']));
}
