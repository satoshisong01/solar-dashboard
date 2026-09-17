// 종합 요약 4줄을 LLM 문장으로 바꾸는 흐름 (호출 → 읽기 → 검증 → 채택 또는 폴백).
// 발견사항 설명(explain.ts)과 같은 규칙이다: 판정과 수치는 분석 엔진이 내고, 모델은 문장만 다시 쓴다.
// 어떤 경로로 실패해도 틀 문장(digestTemplate)을 그대로 돌려준다 — 화면은 배지로만 출처를 구분한다.
import { digestLabels, type DigestStats, type DigestSummary } from '@/lib/desk/digest';
import { buildDigestRequest, DIGEST_PROMPT_VERSION, engineDigestLines, parseDigestLines } from './digest-prompt';
import { DIGEST_LINE_KEYS, type DigestLineKey, type DigestLines, type LlmFailureReason, type LlmProvider } from './types';
import { validateLines, type LineIssue } from './validate';

export type DigestIssue = LineIssue<DigestLineKey>;

export interface DigestValidation {
  readonly ok: boolean;
  /** 틀 문장으로 되돌아간 사유 (채택했으면 null) */
  readonly reason: LlmFailureReason | null;
  readonly detail: string;
  readonly issues: readonly DigestIssue[];
}

export interface DigestResult {
  readonly source: 'llm' | 'template';
  readonly summary: DigestSummary;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly validation: DigestValidation;
}

const fallback = (summary: DigestSummary, model: string | null, reason: LlmFailureReason, detail: string, issues: readonly DigestIssue[] = []): DigestResult => ({
  source: 'template',
  summary,
  model,
  promptVersion: DIGEST_PROMPT_VERSION,
  validation: { ok: false, reason, detail, issues },
});

/** 검증을 통과한 줄만 갈아 끼운다. 엔진이 만들지 않은 줄(null)은 그대로 null */
function merge(summary: DigestSummary, lines: DigestLines): DigestSummary {
  const replaced = Object.fromEntries(DIGEST_LINE_KEYS.map((key) => [key, summary[key] === null ? null : (lines[key] ?? summary[key])]));
  return { ...summary, ...replaced };
}

export interface DigestInput {
  readonly stats: DigestStats;
  /** 엔진이 만든 틀 문장 (수치·분류의 출처) */
  readonly template: DigestSummary;
}

/**
 * provider가 null이면 부르지 않는다 (키 없음·AI 설명 꺼짐).
 * 생성에 성공해도 검증을 통과하지 못하면 틀 문장으로 되돌리고 사유를 남긴다 —
 * 엔진이 세지 않은 숫자가 한 개라도 들어가면 채택하지 않는다.
 */
export async function explainDigest(input: DigestInput, provider: LlmProvider | null): Promise<DigestResult> {
  const { stats, template } = input;
  if (provider === null) return fallback(template, null, 'no_key', 'AI 설명을 쓰지 않는 설정이거나 GEMINI_API_KEY가 없습니다');

  const outcome = await provider.complete(buildDigestRequest(stats, template));
  if (!outcome.ok) return fallback(template, provider.model, outcome.reason, outcome.detail);

  const lines = parseDigestLines(outcome.text);
  if (lines === null) return fallback(template, provider.model, 'bad_response', 'JSON 객체로 읽을 수 없습니다');

  // 방향(증가·감소)은 여러 건을 묶은 요약이라 따지지 않는다 — 숫자·이름·금지 표현만 본다
  const issues = validateLines(DIGEST_LINE_KEYS, lines, { lines: engineDigestLines(template), labels: digestLabels(stats), direction: null });
  if (issues.length > 0) return fallback(template, provider.model, 'rejected', `검증 ${issues.length}건 불일치`, issues);

  return { source: 'llm', summary: merge(template, lines), model: provider.model, promptVersion: DIGEST_PROMPT_VERSION, validation: { ok: true, reason: null, detail: '', issues: [] } };
}
