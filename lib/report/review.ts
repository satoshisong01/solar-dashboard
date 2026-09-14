// 리포트 초안 검토 상태 (순수): 문장 편집(숫자 토큰 잠금) · 블록 포함/제외(사유) · 저장된 jsonb 읽기.
// 편집은 새 초안 객체를 돌려주고 원본을 바꾸지 않는다. 승인 여부 확인(상태 draft)은 DB 서비스가 한다.
import { asArray, asBoolean, asNumber, asRecord, asString } from '@/lib/desk/json-read';
import type { DraftBlock, NumberToken, ReportDraft, SectionKind, TokenFormat } from './composer';
import { textTokenIssues } from './tokens';

export const BLOCK_TEXT_MAX = 2_000;
export const EXCLUDE_REASON_MAX = 200;

export interface ReviewBlock extends DraftBlock {
  readonly included: boolean;
  readonly excludeReason: string | null;
  /** 안전 고정 문구처럼 편집·제외할 수 없는 블록 */
  readonly locked: boolean;
  readonly originalText: string;
  readonly editedBy: string | null;
  readonly editedAt: number | null;
}

export interface ReviewSection {
  readonly kind: SectionKind;
  readonly title: string;
  readonly blocks: readonly ReviewBlock[];
}

export interface ReviewDraft {
  readonly composerId: string;
  readonly packHash: string;
  readonly title: string;
  readonly sections: readonly ReviewSection[];
}

export type ReviewResult = { readonly ok: true; readonly draft: ReviewDraft } | { readonly ok: false; readonly error: string };

export function toReviewDraft(draft: ReportDraft): ReviewDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((b) => ({ ...b, included: true, excludeReason: null, locked: section.kind === 'safety', originalText: b.text, editedBy: null, editedAt: null })),
    })),
  };
}

export function findBlock(draft: ReviewDraft, blockId: string): ReviewBlock | null {
  return draft.sections.flatMap((s) => s.blocks).find((b) => b.id === blockId) ?? null;
}

function updateBlock(draft: ReviewDraft, blockId: string, change: (block: ReviewBlock) => ReviewBlock): ReviewDraft {
  return { ...draft, sections: draft.sections.map((section) => ({ ...section, blocks: section.blocks.map((b) => (b.id === blockId ? change(b) : b)) })) };
}

/** 편집한 문장이 원래 숫자 토큰(값·개수)과 이름 토큰을 그대로 담고 있는가. 문제가 없으면 null */
export function tokenPreservationError(tokens: readonly NumberToken[], text: string): string | null {
  const issues = textTokenIssues(text, tokens);
  if (issues.length === 0) return null;
  const missing = issues.filter((i) => i.code !== 'untracked_number').map((i) => i.message);
  const added = issues.filter((i) => i.code === 'untracked_number').map((i) => i.message);
  return `숫자는 편집할 수 없습니다. ${[...missing, ...added].join(' · ')}`;
}

export function editBlockText(draft: ReviewDraft, blockId: string, rawText: string, actor: string, nowMs: number): ReviewResult {
  const block = findBlock(draft, blockId);
  if (!block) return { ok: false, error: '블록을 찾을 수 없습니다' };
  if (block.locked) return { ok: false, error: '고정 문구는 편집할 수 없습니다' };
  const text = rawText.replace(/\r\n/g, '\n').trim();
  if (text === '') return { ok: false, error: '문장을 입력하세요' };
  if (text.length > BLOCK_TEXT_MAX) return { ok: false, error: `문장은 ${BLOCK_TEXT_MAX}자 이하입니다` };
  const tokenError = tokenPreservationError(block.numberTokens, text);
  if (tokenError) return { ok: false, error: tokenError };
  if (text === block.text) return { ok: true, draft };
  return { ok: true, draft: updateBlock(draft, blockId, (b) => ({ ...b, text, editedBy: actor, editedAt: nowMs })) };
}

export function setBlockInclusion(draft: ReviewDraft, blockId: string, included: boolean, rawReason: string | null, actor: string, nowMs: number): ReviewResult {
  const block = findBlock(draft, blockId);
  if (!block) return { ok: false, error: '블록을 찾을 수 없습니다' };
  if (block.locked) return { ok: false, error: '고정 문구는 제외할 수 없습니다' };
  const reason = (rawReason ?? '').trim();
  if (!included && reason === '') return { ok: false, error: '제외 사유를 입력하세요' };
  if (reason.length > EXCLUDE_REASON_MAX) return { ok: false, error: `제외 사유는 ${EXCLUDE_REASON_MAX}자 이하입니다` };
  return { ok: true, draft: updateBlock(draft, blockId, (b) => ({ ...b, included, excludeReason: included ? null : reason, editedBy: actor, editedAt: nowMs })) };
}

/** 승인 시 in_report로 옮길 발견사항: 포함한 할 일·발견사항·데이터 품질 블록이 인용한 finding id */
export function reportedFindingIds(draft: ReviewDraft): string[] {
  const kinds: readonly SectionKind[] = ['todo', 'findings', 'data_quality'];
  const ids = draft.sections
    .filter((s) => kinds.includes(s.kind))
    .flatMap((s) => s.blocks.filter((b) => b.included))
    .flatMap((b) => b.citations.filter((c) => c.startsWith('finding:')).map((c) => c.slice('finding:'.length)));
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
}

const SECTION_KINDS: readonly SectionKind[] = ['summary', 'todo', 'findings', 'data_quality', 'verified_actions', 'kpi', 'safety'];
const TOKEN_FORMATS: readonly TokenFormat[] = ['number', 'signed', 'percent', 'date', 'duration', 'label'];

function parseToken(raw: unknown): NumberToken | null {
  const t = asRecord(raw);
  const text = asString(t.text);
  const path = asString(t.path);
  const format = asString(t.format);
  if (text === null || path === null || format === null || !(TOKEN_FORMATS as readonly string[]).includes(format)) return null;
  return { text, path, format: format as TokenFormat, digits: asNumber(t.digits) ?? 0, abs: asBoolean(t.abs) ?? false };
}

function parseBlock(raw: unknown, kind: SectionKind): ReviewBlock | null {
  const b = asRecord(raw);
  const id = asString(b.id);
  const text = asString(b.text);
  if (id === null || text === null) return null;
  const tokens = asArray(b.numberTokens).map(parseToken);
  if (tokens.some((t) => t === null)) return null;
  return {
    id,
    text,
    citations: asArray(b.citations).flatMap((c) => (typeof c === 'string' ? [c] : [])),
    numberTokens: tokens as NumberToken[],
    included: asBoolean(b.included) ?? true,
    excludeReason: asString(b.excludeReason),
    locked: asBoolean(b.locked) ?? kind === 'safety',
    originalText: asString(b.originalText) ?? text,
    editedBy: asString(b.editedBy),
    editedAt: asNumber(b.editedAt),
  };
}

/** om.report.draft jsonb → 검토 초안. 형식이 깨졌으면 null */
export function parseReviewDraft(raw: unknown): ReviewDraft | null {
  const d = asRecord(raw);
  const composerId = asString(d.composerId);
  const packHash = asString(d.packHash);
  if (composerId === null || packHash === null) return null;
  const sections = asArray(d.sections).map((rawSection): ReviewSection | null => {
    const s = asRecord(rawSection);
    const kind = asString(s.kind);
    if (kind === null || !(SECTION_KINDS as readonly string[]).includes(kind)) return null;
    const blocks = asArray(s.blocks).map((b) => parseBlock(b, kind as SectionKind));
    return blocks.some((b) => b === null) ? null : { kind: kind as SectionKind, title: asString(s.title) ?? kind, blocks: blocks as ReviewBlock[] };
  });
  if (sections.length === 0 || sections.some((s) => s === null)) return null;
  return { composerId, packHash, title: asString(d.title) ?? '', sections: sections as ReviewSection[] };
}
