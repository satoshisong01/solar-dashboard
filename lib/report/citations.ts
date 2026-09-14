// 인용 칩 표시 (순수): 블록 citations id → 이름·링크. 저장된 validation jsonb 읽기. 서버·클라이언트 공용.
import { asArray, asBoolean, asNumber, asRecord, asString } from '@/lib/desk/json-read';
import { kpiDisplay } from './kpi-labels';
import type { EvidencePack } from './pack-types';
import type { ValidationIssue, ValidationIssueCode, ValidationResult } from './validate';

export interface CitationChip {
  readonly id: string;
  readonly label: string;
  readonly href: string | null;
}

export function citationChip(id: string, pack: Pick<EvidencePack, 'verifiedActions' | 'revenueSummary'>): CitationChip {
  const colon = id.indexOf(':');
  const [kind, value] = colon < 0 ? [id, ''] : [id.slice(0, colon), id.slice(colon + 1)];
  switch (kind) {
    case 'finding':
      return { id, label: `발견사항 #${value}`, href: `/desk/${encodeURIComponent(value)}` };
    case 'evidence':
      return { id, label: `근거 #${value}`, href: null };
    case 'verification': {
      const action = pack.verifiedActions.find((a) => a.verificationId === value);
      return { id, label: `효과 검증 #${value}`, href: action ? `/actions/${encodeURIComponent(action.actionId)}` : null };
    }
    case 'action':
      return { id, label: `조치 #${value}`, href: `/actions/${encodeURIComponent(value)}` };
    case 'kpi':
      return { id, label: `KPI ${kpiDisplay(value).label}`, href: null };
    case 'market':
      return { id, label: pack.revenueSummary.find((r) => r.key === value)?.label ?? value, href: null };
    case 'stats':
      return { id, label: '팩 집계', href: null };
    case 'energy':
      return { id, label: '발전·수소 계측', href: null };
    case 'data_quality':
      return { id, label: '데이터 품질 요약', href: null };
    default:
      return { id, label: id, href: null };
  }
}

export interface StoredValidationView extends ValidationResult {
  readonly checkedAt: number | null;
}

const ISSUE_CODES: readonly ValidationIssueCode[] = ['token_path', 'token_value', 'untracked_number', 'missing_number', 'missing_label', 'pack_hash_mismatch', 'citation_missing', 'severity_not_mentioned', 'forbidden_expression', 'safety_notice_missing', 'exclude_reason_missing', 'empty_text'];

/** om.report.validation jsonb → 표시용. 모르는 값은 검증 실패로 본다 */
export function parseStoredValidation(raw: unknown): StoredValidationView {
  const v = asRecord(raw);
  const issues = asArray(v.issues).flatMap((item): ValidationIssue[] => {
    const i = asRecord(item);
    const code = asString(i.code);
    if (code === null || !(ISSUE_CODES as readonly string[]).includes(code)) return [];
    return [{ code: code as ValidationIssueCode, blockId: asString(i.blockId), message: asString(i.message) ?? code }];
  });
  return { ok: asBoolean(v.ok) === true && issues.length === 0, issues, checkedBlocks: asNumber(v.checkedBlocks) ?? 0, checkedAt: asNumber(v.checkedAt) };
}

export const REPORT_STATUS_LABELS: Readonly<Record<string, string>> = { draft: '초안', approved: '승인', superseded: '대체됨' };
export const reportStatusLabel = (status: string): string => REPORT_STATUS_LABELS[status] ?? status;

export const JUDGEMENT_LABELS: Readonly<Record<string, string>> = { confirmed: '확정', provisional: '잠정', hold: '판정 보류' };
