// 리포트 초안 문장 다듬기 (설계 §5.4). 어떤 항목·수치·우선순위를 말할지는 팩(planner)이 이미 정했고,
// 여기서는 블록 본문의 말투만 바꾼다. 숫자 토큰·인용은 그대로 두므로 승인 전 검토 흐름과 숫자 잠금은 달라지지 않는다.
//   - 고정 블록('즉시 확인 필요'·안전 고정 문구)은 건드리지 않는다
//   - 블록마다 리포트와 같은 검사(숫자 토큰·방향·금지 표현)를 다시 돌려, 통과한 블록만 갈아 끼운다
//   - 한 블록이라도 갈아 끼웠으면 composerId를 llmComposer@1로 바꿔 출처를 남긴다
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { asArray, asRecord, asString } from '@/lib/desk/json-read';
import { SAFETY_NOTICE, URGENT_BLOCK_ID, type DraftBlock, type ReportDraft } from '@/lib/report/composer';
import { directionIssues } from '@/lib/report/direction';
import type { EvidencePack } from '@/lib/report/pack-types';
import { blockTokenIssues } from '@/lib/report/tokens';
import { forbiddenReasons } from '@/lib/report/validate';
import { aiEnabledFor, readAiSettings } from '@/lib/ops/ai-settings';
import { getGeminiProvider } from './gemini';
import { PLAIN_FORBIDDEN } from './validate';
import type { LlmProvider, LlmRequest } from './types';

export const LLM_COMPOSER_ID = 'llmComposer@1';
export const REPORT_PROMPT_VERSION = 'report@1';

const TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 3000;

const SYSTEM = [
  '당신은 태양광·수소 발전소 월간 코칭 리포트의 문장 다듬기 도우미입니다.',
  '분석 엔진이 이미 무엇을 어떤 수치로 말할지 정했습니다. 당신이 하는 일은 각 블록의 본문을 담당자가 읽기 쉬운 우리말로 다시 쓰는 것뿐입니다.',
  '',
  '반드시 지킬 것',
  '1. 숫자·날짜·시간·설비 경로는 원문에 나온 글자 그대로 씁니다. 자릿수를 줄이거나 늘리지 말고, 새 숫자를 만들지 마세요.',
  '2. 숫자를 빼지도 마세요. 원문에 있는 값은 모두 그대로 남아야 합니다.',
  '3. 늘었다/줄었다 같은 방향을 바꾸지 마세요.',
  '4. 사실을 더하거나 빼지 말고, 원인을 단정하지 마세요. 안전·법적·계약적 판단을 하지 마세요.',
  '5. 블록 하나는 원문과 비슷한 길이로, 전문 용어 대신 쉬운 말로 씁니다.',
  '',
  '출력은 {"blocks": [{"id": 원문 id, "text": 다시 쓴 본문}, …]} 형태의 JSON 객체 하나입니다. 받은 블록만, 받은 id 그대로 넣으세요.',
].join('\n');

/** 편집할 수 없는 고정 블록 (안전 고정 문구·'즉시 확인 필요') */
const isFixed = (block: DraftBlock): boolean => block.id === URGENT_BLOCK_ID || block.text.includes(SAFETY_NOTICE);

const plainForbidden = (text: string): string[] => PLAIN_FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);

/** 리포트 검증과 같은 검사. 하나라도 걸리면 그 블록은 원문을 그대로 둔다 */
function blockRejections(block: DraftBlock, original: DraftBlock, pack: EvidencePack): string[] {
  const already = new Set([...forbiddenReasons(original.text), ...plainForbidden(original.text)]);
  return [
    ...blockTokenIssues(block, pack).map((issue) => issue.message),
    ...directionIssues(block, pack).map((issue) => `방향 불일치: ${issue.found}`),
    ...[...forbiddenReasons(block.text), ...plainForbidden(block.text)].filter((reason) => !already.has(reason)).map((reason) => `금지 표현: ${reason}`),
  ];
}

function buildRequest(blocks: readonly DraftBlock[]): LlmRequest {
  const payload = { blocks: blocks.map((block) => ({ id: block.id, text: block.text })) };
  return { system: SYSTEM, user: JSON.stringify(payload), temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS };
}

const unfence = (text: string): string => text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

/** 응답 → id별 새 본문. 읽을 수 없으면 null */
function parseBlocks(text: string): ReadonlyMap<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return null;
  }
  return new Map(
    asArray(asRecord(parsed).blocks).flatMap((item): (readonly [string, string])[] => {
      const row = asRecord(item);
      const id = asString(row.id);
      const body = asString(row.text);
      return id === null || body === null || body.trim() === '' ? [] : [[id, body.trim()] as const];
    }),
  );
}

export interface RefineOptions {
  readonly provider: LlmProvider | null;
  readonly enabled: boolean;
}

/** 검증을 통과한 블록만 갈아 끼운 초안. 끄거나 실패하면 받은 초안을 그대로 돌려준다 */
export async function refineDraft(draft: ReportDraft, pack: EvidencePack, options: RefineOptions): Promise<ReportDraft> {
  const { provider } = options;
  if (!options.enabled || provider === null) return draft;
  const editable = draft.sections.flatMap((section) => section.blocks.filter((block) => !isFixed(block) && block.text.trim() !== ''));
  if (editable.length === 0) return draft;

  const outcome = await provider.complete(buildRequest(editable));
  if (!outcome.ok) {
    console.warn('[llm/report] 틀 문장을 그대로 씁니다', { reason: outcome.reason, detail: outcome.detail });
    return draft;
  }
  const replacements = parseBlocks(outcome.text);
  if (replacements === null || replacements.size === 0) {
    console.warn('[llm/report] 응답을 읽을 수 없어 틀 문장을 그대로 씁니다');
    return draft;
  }

  const rejected: string[] = [];
  let replacedCount = 0;
  const sections = draft.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block): DraftBlock => {
      const text = replacements.get(block.id);
      if (text === undefined || isFixed(block) || text === block.text) return block;
      const candidate = { ...block, text };
      const issues = blockRejections(candidate, block, pack);
      if (issues.length > 0) {
        rejected.push(`${block.id}: ${issues[0] ?? ''}`);
        return block;
      }
      replacedCount += 1;
      return candidate;
    }),
  }));
  if (rejected.length > 0) console.warn('[llm/report] 검증에 걸린 블록은 틀 문장으로 되돌림', { model: provider.model, rejected });
  if (replacedCount === 0) return draft;
  return { ...draft, composerId: LLM_COMPOSER_ID, sections };
}

export type DraftRefiner = (draft: ReportDraft, pack: EvidencePack) => Promise<ReportDraft>;

/** 사이트 설정과 키를 읽어 다듬기를 붙인다. AI 설명이 꺼져 있거나 키가 없으면 아무것도 바꾸지 않는다 */
export function defaultDraftRefiner(db: Kysely<DB>, siteId: number): DraftRefiner {
  return async (draft, pack) => {
    const provider = getGeminiProvider();
    const settings = await readAiSettings(db);
    return refineDraft(draft, pack, { provider, enabled: aiEnabledFor(settings, siteId, provider !== null) });
  };
}
