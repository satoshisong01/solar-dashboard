// 발견사항 쉬운 말 4줄을 LLM 문장으로 바꾸는 흐름 (호출 → 읽기 → 검증 → 채택 또는 폴백).
// 어떤 경로로 실패해도 과제 2의 틀 문장을 그대로 돌려준다. 사용자에게는 배지로만 구분한다.
import type { EvidenceView } from '@/lib/desk/evidence-types';
import type { PlainSummary } from '@/lib/desk/plain';
import { subjectText } from '@/lib/desk/plain';
import { SAFETY_DECISION_NOTICE } from '@/lib/desk/plain/outlook';
import { effectDirection } from '@/lib/report/direction';
import { buildPlainRequest, engineLines, parsePlainLines, PLAIN_PROMPT_VERSION, type ExplainFinding } from './prompt';
import { PLAIN_LINE_KEYS, type LlmFailureReason, type LlmProvider, type PlainLines } from './types';
import { validatePlainLines, type PlainIssue, type PlainReference } from './validate';

export interface ExplainValidation {
  readonly ok: boolean;
  /** 틀 문장으로 되돌아간 사유 (채택했으면 null) */
  readonly reason: LlmFailureReason | null;
  readonly detail: string;
  readonly issues: readonly PlainIssue[];
}

export interface ExplainResult {
  readonly source: 'llm' | 'template';
  readonly summary: PlainSummary;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly validation: ExplainValidation;
}

/** 이름 토큰: 문장에서 숫자로 세지 않고, 엔진 문장에 있었으면 그대로 남아야 하는 말 */
function labelsOf(finding: ExplainFinding): readonly string[] {
  const names = [subjectText(finding), finding.assetName, finding.assetCode, finding.siteName];
  return [...new Set(names.filter((name): name is string => name !== null && name !== ''))];
}

export function plainReferenceOf(finding: ExplainFinding, summary: PlainSummary): PlainReference {
  return { lines: engineLines(summary), labels: labelsOf(finding), direction: effectDirection(finding.effect.metric, finding.effect.value) };
}

const fallback = (summary: PlainSummary, model: string | null, reason: LlmFailureReason, detail: string, issues: readonly PlainIssue[] = []): ExplainResult => ({
  source: 'template',
  summary,
  model,
  promptVersion: PLAIN_PROMPT_VERSION,
  validation: { ok: false, reason, detail, issues },
});

/**
 * 엔진이 소유한 고정 안전 문구를 되돌려 놓는다.
 * 모델이 '각 줄 두 문장 이내' 규칙에 맞추려고 마지막 문장을 버리면 그 줄이 통째로 검증에서 걸려,
 * 정작 가장 급한 안전 발견사항만 AI 설명을 받지 못했다. 이 문구는 모델이 고쳐 쓸 문장이 아니라
 * 엔진의 고정 문장이므로, 모델에게 다시 맡기지 않고 서버가 검증 직전에 붙인다 (남아 있으면 그대로 둔다).
 */
export function withSafetyNotice(lines: PlainLines, reference: PlainReference): PlainLines {
  const restored = PLAIN_LINE_KEYS.flatMap((key) => {
    const text = lines[key]?.trim();
    const engineText = reference.lines[key];
    if (text === undefined || text === '' || engineText === undefined) return [];
    if (!engineText.includes(SAFETY_DECISION_NOTICE) || text.includes(SAFETY_DECISION_NOTICE)) return [];
    return [[key, `${text} ${SAFETY_DECISION_NOTICE}`] as const];
  });
  return restored.length === 0 ? lines : { ...lines, ...Object.fromEntries(restored) };
}

/** 검증을 통과한 줄만 갈아 끼운다. 엔진이 만들지 않은 줄(null)은 그대로 null */
function merge(summary: PlainSummary, lines: PlainLines): PlainSummary {
  const replaced = Object.fromEntries(PLAIN_LINE_KEYS.map((key) => [key, summary[key] === null ? null : (lines[key] ?? summary[key])]));
  return { ...summary, ...replaced };
}

export interface ExplainInput {
  readonly finding: ExplainFinding;
  readonly evidence: EvidenceView;
  /** 과제 2의 틀 문장 (수치·판정의 출처) */
  readonly template: PlainSummary;
}

/**
 * provider가 null이면 부르지 않는다 (키 없음·AI 설명 꺼짐).
 * 성공해도 검증을 통과하지 못하면 틀 문장으로 되돌리고 사유를 남긴다.
 */
export async function explainFinding(input: ExplainInput, provider: LlmProvider | null): Promise<ExplainResult> {
  const { finding, evidence, template } = input;
  if (provider === null) return fallback(template, null, 'no_key', 'AI 설명을 쓰지 않는 설정이거나 GEMINI_API_KEY가 없습니다');

  const outcome = await provider.complete(buildPlainRequest(finding, evidence, template));
  if (!outcome.ok) return fallback(template, provider.model, outcome.reason, outcome.detail);

  const parsed = parsePlainLines(outcome.text);
  if (parsed === null) return fallback(template, provider.model, 'bad_response', 'JSON 객체로 읽을 수 없습니다');

  const reference = plainReferenceOf(finding, template);
  const lines = withSafetyNotice(parsed, reference);
  const issues = validatePlainLines(lines, reference);
  if (issues.length > 0) return fallback(template, provider.model, 'rejected', `검증 ${issues.length}건 불일치`, issues);

  return { source: 'llm', summary: merge(template, lines), model: provider.model, promptVersion: PLAIN_PROMPT_VERSION, validation: { ok: true, reason: null, detail: '', issues: [] } };
}
