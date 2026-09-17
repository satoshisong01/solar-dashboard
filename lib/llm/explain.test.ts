// 생성 흐름 5가지 경로: 성공 · 검증 실패 · 타임아웃 · 429 · 키 없음. 실제 API는 부르지 않는다.
import { describe, expect, it } from 'vitest';
import { plainSummary } from '@/lib/desk/plain';
import { SAFETY_DECISION_NOTICE } from '@/lib/desk/plain/outlook';
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

// 안전 발견사항의 outlook은 고정 안전 문구로 끝나는 서너 문장이라, 모델이 '두 문장 이내' 규칙에 맞추려고
// 마지막 문장을 버리면 가장 급한 건만 AI 설명을 받지 못했다 (운영 #7·#14가 그랬다).
describe.each(['o2.purity_drift', 'prv.seat_leak'])('고정 안전 문구 (%s)', (detectorId) => {
  const safetyCase = llmCase(detectorId);
  const template = plainSummary(safetyCase.finding, safetyCase.evidence);
  const input = { finding: explainFindingOf(safetyCase, 'safety'), evidence: safetyCase.evidence, template };
  const safetyLines = engineLines(template);
  const withoutNotice = (safetyLines.outlook ?? '').replace(SAFETY_DECISION_NOTICE, '').trim();

  it('엔진 문장이 고정 안전 문구로 끝난다', () => {
    expect(safetyLines.outlook).toContain(SAFETY_DECISION_NOTICE);
    expect(withoutNotice).not.toContain(SAFETY_DECISION_NOTICE);
  });

  it('모델이 문구를 지워도 서버가 되돌려 붙이고 채택한다', async () => {
    const provider = fakeProvider(jsonReply({ ...safetyLines, outlook: withoutNotice }));

    const result = await explainFinding(input, provider);

    expect(result.validation.issues).toEqual([]);
    expect(result.source).toBe('llm');
    expect(result.summary.outlook).toContain(SAFETY_DECISION_NOTICE);
    expect(result.summary.outlook?.endsWith(SAFETY_DECISION_NOTICE)).toBe(true);
  });

  it('모델이 남긴 문구는 그대로 두고 두 번 붙이지 않는다', async () => {
    const provider = fakeProvider(jsonReply(safetyLines));

    const result = await explainFinding(input, provider);

    expect(result.source).toBe('llm');
    expect(result.summary.outlook?.split(SAFETY_DECISION_NOTICE)).toHaveLength(2);
  });

  it('문구를 되돌려도 다른 사실이 빠졌으면 거부한다', async () => {
    const provider = fakeProvider(jsonReply({ ...safetyLines, outlook: '점검이 필요합니다.' }));

    const result = await explainFinding(input, provider);

    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('missing_number');
  });

  it('프롬프트가 고정 안전 문구를 글자 그대로 알려 준다', async () => {
    const provider = fakeProvider(jsonReply(safetyLines));

    await explainFinding(input, provider);

    expect(provider.requests[0]?.system).toContain(SAFETY_DECISION_NOTICE);
  });
});
