// 생성 흐름 5가지 경로: 성공 · 검증 실패 · 타임아웃 · 429 · 키 없음. 실제 API는 부르지 않는다.
import { describe, expect, it } from 'vitest';
import { plainSummary } from '@/lib/desk/plain';
import { explainFinding } from './explain';
import { engineLines, PLAIN_PROMPT_VERSION } from './prompt';
import { explainFindingOf, fakeProvider, jsonReply, llmCase } from './test-fixtures';
import type { LlmOutcome } from './types';

const CASE = llmCase('ess.capacity_fade');
const TEMPLATE = plainSummary(CASE.finding, CASE.evidence);
const INPUT = { finding: explainFindingOf(CASE), evidence: CASE.evidence, template: TEMPLATE };
const lines = engineLines(TEMPLATE);

describe('explainFinding', () => {
  it('검증을 통과한 문장은 채택하고 출처를 llm으로 남긴다', async () => {
    const provider = fakeProvider(jsonReply({ ...lines, what: `확인 결과, ${TEMPLATE.what}` }), 'fake-flash');

    const result = await explainFinding(INPUT, provider);

    expect(result.source).toBe('llm');
    expect(result.summary.what).toBe(`확인 결과, ${TEMPLATE.what}`);
    expect(result.summary.basis).toBe(TEMPLATE.basis);
    expect(result.model).toBe('fake-flash');
    expect(result.promptVersion).toBe(PLAIN_PROMPT_VERSION);
    expect(result.validation).toEqual({ ok: true, reason: null, detail: '', issues: [] });
  });

  it('보내는 프롬프트에 원시 시계열이 들어가지 않는다', async () => {
    const provider = fakeProvider(jsonReply(lines));

    await explainFinding(INPUT, provider);

    const payload = JSON.parse(provider.requests[0]?.user ?? '{}');
    expect(payload.evidence.kind).toBe('capacity');
    expect(payload.evidence.trend?.points).toBeUndefined();
    expect(payload.engineSentences.what).toBe(TEMPLATE.what);
    expect(provider.requests[0]?.user).not.toContain('"points"');
    expect(provider.requests[0]?.user).not.toContain('overlay');
  });

  it('엔진에 없는 숫자를 넣으면 거부하고 틀 문장으로 되돌린다', async () => {
    const provider = fakeProvider(jsonReply({ ...lines, what: `${TEMPLATE.what} 교체 비용은 1,200만 원입니다.` }));

    const result = await explainFinding(INPUT, provider);

    expect(result.source).toBe('template');
    expect(result.summary).toEqual(TEMPLATE);
    expect(result.validation.reason).toBe('rejected');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('untracked_number');
  });

  it('방향을 뒤집으면 거부한다', async () => {
    const provider = fakeProvider(jsonReply({ ...lines, what: TEMPLATE.what.replace('줄었습니다', '늘었습니다') }));

    const result = await explainFinding(INPUT, provider);

    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('direction_mismatch');
  });

  it('금지 표현을 넣으면 거부한다', async () => {
    const provider = fakeProvider(jsonReply({ ...lines, outlook: `${TEMPLATE.outlook} 원인은 셀 열화입니다.` }));

    const result = await explainFinding(INPUT, provider);

    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('forbidden_expression');
  });

  it.each<[string, LlmOutcome]>([
    ['타임아웃', { ok: false, reason: 'timeout', detail: '20000ms 안에 응답이 없습니다' }],
    ['429', { ok: false, reason: 'rate_limited', detail: 'HTTP 429' }],
    ['5xx', { ok: false, reason: 'server_error', detail: 'HTTP 503' }],
  ])('%s이면 틀 문장으로 되돌리고 사유를 남긴다', async (_name, outcome) => {
    const result = await explainFinding(INPUT, fakeProvider(outcome));

    expect(result.source).toBe('template');
    expect(result.summary).toEqual(TEMPLATE);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.reason).toBe(outcome.ok ? null : outcome.reason);
  });

  it('키가 없으면 부르지 않고 틀 문장만 쓴다', async () => {
    const result = await explainFinding(INPUT, null);

    expect(result.source).toBe('template');
    expect(result.summary).toEqual(TEMPLATE);
    expect(result.model).toBeNull();
    expect(result.validation.reason).toBe('no_key');
  });

  it('JSON이 아닌 응답은 거부한다', async () => {
    const result = await explainFinding(INPUT, fakeProvider({ ok: true, text: '배터리 용량이 줄었습니다.' }));

    expect(result.source).toBe('template');
    expect(result.validation.reason).toBe('bad_response');
  });

  it('코드블록으로 감싼 JSON은 읽는다', async () => {
    const result = await explainFinding(INPUT, fakeProvider({ ok: true, text: '```json\n' + JSON.stringify(lines) + '\n```' }));

    expect(result.source).toBe('llm');
  });
});
