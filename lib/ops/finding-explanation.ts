// 발견사항 쉬운 말 설명의 저장·재사용 (om.finding_explanation).
// 같은 근거(evidence_id)면 저장된 문장을 그대로 쓰고, 근거가 바뀌면(새 evidence_id) 다시 만든다 — 화면을 볼 때마다 모델을 부르지 않는다.
// AI 설명을 끄거나 키가 없으면 행을 만들지 않는다 (나중에 켜면 그때 만들 수 있게).
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 권한 확인은 page·Server Action이 한다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { EvidenceView } from '@/lib/desk/evidence-types';
import { asArray, asBoolean, asRecord, asString } from '@/lib/desk/json-read';
import type { PlainSummary } from '@/lib/desk/plain';
import { explainFinding, type ExplainValidation } from '@/lib/llm/explain';
import { PLAIN_PROMPT_VERSION, type ExplainFinding } from '@/lib/llm/prompt';
import type { LlmFailureReason, LlmProvider } from '@/lib/llm/types';
import type { PlainIssue } from '@/lib/llm/validate';

export interface Explanation {
  readonly source: 'template' | 'llm';
  readonly summary: PlainSummary;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly validation: ExplainValidation;
  /** 저장된 행을 그대로 쓴 것인가 (이번에 만들지 않았다) */
  readonly cached: boolean;
}

const summaryJson = (summary: PlainSummary) => ({ what: summary.what, basis: summary.basis, outlook: summary.outlook, nextStep: summary.nextStep, hold: summary.hold });

function parseSummary(raw: unknown): PlainSummary | null {
  const record = asRecord(raw);
  const what = asString(record.what);
  if (what === null) return null;
  return { what, basis: asString(record.basis), outlook: asString(record.outlook), nextStep: asString(record.nextStep), hold: asBoolean(record.hold) ?? false };
}

function parseValidation(raw: unknown): ExplainValidation {
  const record = asRecord(raw);
  const issues = asArray(record.issues).flatMap((item): PlainIssue[] => {
    const issue = asRecord(item);
    const code = asString(issue.code);
    return code === null ? [] : [{ code: code as PlainIssue['code'], line: asString(issue.line) as PlainIssue['line'], message: asString(issue.message) ?? '' }];
  });
  return { ok: asBoolean(record.ok) ?? false, reason: asString(record.reason) as LlmFailureReason | null, detail: asString(record.detail) ?? '', issues };
}

export async function readExplanation(db: Kysely<DB>, findingId: string, evidenceId: string): Promise<Explanation | null> {
  const row = await db
    .selectFrom('om.finding_explanation')
    .select(['source', 'model', 'prompt_version', 'text', 'validation'])
    .where('finding_id', '=', findingId)
    .where('evidence_id', '=', evidenceId)
    .executeTakeFirst();
  if (!row) return null;
  const summary = parseSummary(row.text);
  if (summary === null) return null;
  return { source: row.source === 'llm' ? 'llm' : 'template', summary, model: row.model, promptVersion: row.prompt_version, validation: parseValidation(row.validation), cached: true };
}

export interface ExplanationInput {
  readonly findingId: string;
  /** 최신 근거 스냅샷 id. 없으면 만들지 않는다 */
  readonly evidenceId: string | null;
  readonly finding: ExplainFinding;
  readonly evidence: EvidenceView;
  /** 과제 2의 틀 문장 (수치·판정의 출처) */
  readonly template: PlainSummary;
  /** 이 사이트에서 AI 설명을 쓰는가 */
  readonly enabled: boolean;
}

const templateOnly = (summary: PlainSummary, reason: LlmFailureReason, detail: string): Explanation => ({
  source: 'template',
  summary,
  model: null,
  promptVersion: PLAIN_PROMPT_VERSION,
  validation: { ok: false, reason, detail, issues: [] },
  cached: false,
});

/**
 * 저장된 문장이 있으면 그것을, 없으면 한 번 만들어 저장한다.
 * regenerate면 저장된 행을 무시하고 다시 만들어 덮어쓴다 ('다시 생성' 버튼).
 */
export async function getOrCreateExplanation(db: Kysely<DB>, input: ExplanationInput, provider: LlmProvider | null, regenerate = false): Promise<Explanation> {
  if (input.evidenceId === null) return templateOnly(input.template, 'no_evidence', '근거 스냅샷이 없습니다');
  if (!regenerate) {
    const stored = await readExplanation(db, input.findingId, input.evidenceId);
    if (stored) return stored;
  }
  if (!input.enabled) return templateOnly(input.template, 'disabled', 'AI 설명을 쓰지 않는 설정입니다');
  if (provider === null) return templateOnly(input.template, 'no_key', 'GEMINI_API_KEY가 없습니다');

  const result = await explainFinding({ finding: input.finding, evidence: input.evidence, template: input.template }, provider);
  if (!result.validation.ok) {
    // 사용자에게는 배지로만 구분하고, 사유는 서버 로그와 DB에 남긴다
    console.warn('[llm/explain] 틀 문장으로 되돌림', { findingId: input.findingId, model: result.model, reason: result.validation.reason, detail: result.validation.detail, issues: result.validation.issues.map((issue) => `${issue.line ?? '-'}:${issue.code}`) });
  }
  const values = {
    finding_id: input.findingId,
    evidence_id: input.evidenceId,
    source: result.source,
    model: result.model,
    prompt_version: result.promptVersion,
    text: JSON.stringify(summaryJson(result.summary)),
    validation: JSON.stringify(result.validation),
    created_at: new Date(),
  };
  await db
    .insertInto('om.finding_explanation')
    .values(values)
    .onConflict((oc) => (regenerate ? oc.columns(['finding_id', 'evidence_id']).doUpdateSet({ source: values.source, model: values.model, prompt_version: values.prompt_version, text: values.text, validation: values.validation, created_at: values.created_at }) : oc.columns(['finding_id', 'evidence_id']).doNothing()))
    .execute();
  return { ...result, cached: false };
}
