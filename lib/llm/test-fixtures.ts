// lib/llm unit 테스트 공용 입력. 실제 API는 부르지 않는다 — 제공자는 언제나 가짜다.
import { plainCases, type PlainCase } from '@/lib/desk/plain/test-fixtures';
import type { ExplainFinding } from './prompt';
import type { LlmOutcome, LlmProvider, LlmRequest } from './types';

export const LLM_CASES: readonly PlainCase[] = plainCases();

export function llmCase(detectorId: string): PlainCase {
  const found = LLM_CASES.find((item) => item.detectorId === detectorId);
  if (!found) throw new Error(`픽스처가 없습니다: ${detectorId}`);
  return found;
}

/** PlainFinding → 프롬프트 입력 (카테고리·설비 경로를 덧붙인다) */
export const explainFindingOf = (item: PlainCase, category = 'degradation'): ExplainFinding => ({
  ...item.finding,
  category,
  assetPath: item.finding.assetCode === null ? null : `SIM-A/${item.finding.assetCode}`,
});

export interface FakeProvider extends LlmProvider {
  readonly requests: readonly LlmRequest[];
}

/** 정해진 답만 돌려주는 가짜 제공자. reply가 배열이면 호출 순서대로 쓴다 */
export function fakeProvider(reply: LlmOutcome | readonly LlmOutcome[], model = 'fake-model'): FakeProvider {
  const requests: LlmRequest[] = [];
  const replies = Array.isArray(reply) ? reply : [reply as LlmOutcome];
  return {
    id: 'fake',
    model,
    requests,
    complete: (request) => {
      requests.push(request);
      const next = replies[Math.min(requests.length - 1, replies.length - 1)];
      if (!next) throw new Error('가짜 응답이 없습니다');
      return Promise.resolve(next);
    },
  };
}

export const jsonReply = (lines: Readonly<Record<string, string>>): LlmOutcome => ({ ok: true, text: JSON.stringify(lines) });
