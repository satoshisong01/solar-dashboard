// 종합 요약의 저장·재사용 (om.finding_digest).
// 발견사항 묶음의 지문이 같으면 저장된 문장을 그대로 쓰고, 묶음이 바뀌면 다시 만든다 — 화면을 볼 때마다 모델을 부르지 않는다.
// 단, 일시적 실패(타임아웃·429·5xx·네트워크)로 되돌아간 틀 문장은 짧은 기간만 쓴다 (lib/llm/retry.ts).
// AI 설명을 끄거나 키가 없으면 틀 문장을 저장한다 (나중에 켜고 '다시 생성'을 누르면 그때 만든다).
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 권한 확인은 page·Server Action이 한다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { hashInput } from '@/lib/analytics/hash';
import type { DigestStats, DigestSummary } from '@/lib/desk/digest';
import { asArray, asBoolean, asRecord, asString } from '@/lib/desk/json-read';
import { explainDigest, type DigestIssue, type DigestValidation } from '@/lib/llm/digest';
import { DIGEST_PROMPT_VERSION } from '@/lib/llm/digest-prompt';
import { canReuseStored } from '@/lib/llm/retry';
import type { DigestLineKey, LlmFailureReason, LlmProvider } from '@/lib/llm/types';

/** 사이트 전체 범위의 scope_key (사이트 코드와 겹치지 않게 대문자 고정값) */
export const ALL_SITES_SCOPE = 'ALL';

export interface Digest {
  readonly source: 'template' | 'llm';
  readonly summary: DigestSummary;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly validation: DigestValidation;
  /** 저장된 행을 그대로 쓴 것인가 (이번에 만들지 않았다) */
  readonly cached: boolean;
  readonly createdAtMs: number;
}

const summaryJson = (summary: DigestSummary) => ({ headline: summary.headline, breakdown: summary.breakdown, urgency: summary.urgency, nextStep: summary.nextStep });

function parseSummary(raw: unknown): DigestSummary | null {
  const record = asRecord(raw);
  const headline = asString(record.headline);
  if (headline === null) return null;
  return { headline, breakdown: asString(record.breakdown), urgency: asString(record.urgency), nextStep: asString(record.nextStep) };
}

function parseValidation(raw: unknown): DigestValidation {
  const record = asRecord(raw);
  const issues = asArray(record.issues).flatMap((item): DigestIssue[] => {
    const issue = asRecord(item);
    const code = asString(issue.code);
    return code === null ? [] : [{ code: code as DigestIssue['code'], line: asString(issue.line) as DigestLineKey | null, message: asString(issue.message) ?? '' }];
  });
  return { ok: asBoolean(record.ok) ?? false, reason: asString(record.reason) as LlmFailureReason | null, detail: asString(record.detail) ?? '', issues };
}

/**
 * 저장 키: 모델에 보내는 것이 그대로면 같은 키다 — 발견사항 묶음의 지문 + 프롬프트 버전 + 엔진이 만든 틀 문장.
 * 틀 문장까지 넣는 이유: 문장 규칙을 고치면 옛 행은 이제 다른 사실을 말하므로 다시 쓰이면 안 된다.
 */
export const digestKeyOf = (fingerprint: string, template: DigestSummary): string => hashInput({ fingerprint, prompt: DIGEST_PROMPT_VERSION, template: summaryJson(template) });

export async function readDigest(db: Kysely<DB>, scopeKey: string, findingsHash: string): Promise<Digest | null> {
  const row = await db
    .selectFrom('om.finding_digest')
    .select(['source', 'model', 'prompt_version', 'text', 'validation', 'created_at'])
    .where('scope_key', '=', scopeKey)
    .where('findings_hash', '=', findingsHash)
    .executeTakeFirst();
  if (!row) return null;
  const summary = parseSummary(row.text);
  if (summary === null) return null;
  return {
    source: row.source === 'llm' ? 'llm' : 'template',
    summary,
    model: row.model,
    promptVersion: row.prompt_version,
    validation: parseValidation(row.validation),
    cached: true,
    createdAtMs: row.created_at.getTime(),
  };
}

export interface DigestStoreInput {
  /** 'ALL' 또는 사이트 코드 */
  readonly scopeKey: string;
  /** 발견사항 묶음의 지문 (lib/desk/digest digestFingerprint) */
  readonly fingerprint: string;
  readonly stats: DigestStats;
  /** 엔진이 만든 틀 문장 (수치·분류의 출처) */
  readonly template: DigestSummary;
  /** 이 범위에서 AI 설명을 쓰는가 */
  readonly enabled: boolean;
}

const templateOnly = (summary: DigestSummary, reason: LlmFailureReason, detail: string): Digest => ({
  source: 'template',
  summary,
  model: null,
  promptVersion: DIGEST_PROMPT_VERSION,
  validation: { ok: false, reason, detail, issues: [] },
  cached: false,
  createdAtMs: Date.now(),
});

/**
 * 저장된 문장이 있으면 그것을, 없으면 한 번 만들어 저장한다.
 * regenerate면 저장된 행을 무시하고 다시 만들어 덮어쓴다 ('다시 생성' 버튼).
 * 일시적 실패로 남은 행은 기간이 지나면 없는 것으로 보고 한 번 더 불러 덮어쓴다.
 */
export async function getOrCreateDigest(db: Kysely<DB>, input: DigestStoreInput, provider: LlmProvider | null, regenerate = false): Promise<Digest> {
  const findingsHash = digestKeyOf(input.fingerprint, input.template);
  const stored = regenerate ? null : await readDigest(db, input.scopeKey, findingsHash);
  if (stored && canReuseStored({ source: stored.source, reason: stored.validation.reason, promptVersion: stored.promptVersion, createdAtMs: stored.createdAtMs }, Date.now(), DIGEST_PROMPT_VERSION)) return stored;
  // 덮어써야 하는가: '다시 생성'이거나, 기간이 지난 일시적 실패 행이 이미 있어 그 자리를 갈아 끼우는 경우
  const overwrite = regenerate || stored !== null;
  if (!input.enabled) return templateOnly(input.template, 'disabled', 'AI 설명을 쓰지 않는 설정입니다');
  if (provider === null) return templateOnly(input.template, 'no_key', 'GEMINI_API_KEY가 없습니다');

  const result = await explainDigest({ stats: input.stats, template: input.template }, provider);
  if (!result.validation.ok) {
    // 사용자에게는 배지로만 구분하고, 사유는 서버 로그와 DB에 남긴다
    console.warn('[llm/digest] 틀 문장으로 되돌림', { scope: input.scopeKey, model: result.model, reason: result.validation.reason, detail: result.validation.detail, issues: result.validation.issues.map((issue) => `${issue.line ?? '-'}:${issue.code}`) });
  }

  const createdAt = new Date();
  const values = {
    scope_key: input.scopeKey,
    findings_hash: findingsHash,
    source: result.source,
    model: result.model,
    prompt_version: result.promptVersion,
    text: JSON.stringify(summaryJson(result.summary)),
    validation: JSON.stringify(result.validation),
    created_at: createdAt,
  };
  await db
    .insertInto('om.finding_digest')
    .values(values)
    .onConflict((oc) =>
      overwrite
        ? oc.columns(['scope_key', 'findings_hash']).doUpdateSet({ source: values.source, model: values.model, prompt_version: values.prompt_version, text: values.text, validation: values.validation, created_at: values.created_at })
        : oc.columns(['scope_key', 'findings_hash']).doNothing(),
    )
    .execute();
  return { ...result, cached: false, createdAtMs: createdAt.getTime() };
}
