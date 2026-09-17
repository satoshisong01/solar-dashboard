// 생성 문장 검증: 엔진 문장 자체는 언제나 통과하고, 숫자 조작·방향 뒤집기·금지 표현은 전부 걸린다.
import { describe, expect, it } from 'vitest';
import { plainSummary } from '@/lib/desk/plain';
import { SAFETY_DECISION_NOTICE } from '@/lib/desk/plain/outlook';
import { plainReferenceOf } from './explain';
import { engineLines } from './prompt';
import { explainFindingOf, LLM_CASES, llmCase } from './test-fixtures';
import { validatePlainLines } from './validate';

const referenceOf = (detectorId: string) => {
  const item = llmCase(detectorId);
  const summary = plainSummary(item.finding, item.evidence);
  return { summary, reference: plainReferenceOf(explainFindingOf(item), summary) };
};

describe('validatePlainLines', () => {
  // 엔진 문장을 그대로 낸 답은 반드시 통과해야 한다. 여기가 깨지면 규칙이 너무 좁아 정상 문장까지 거부한다.
  it.each(LLM_CASES.map((item) => item.detectorId))('%s: 엔진 문장 그대로는 통과한다', (detectorId) => {
    const { summary, reference } = referenceOf(detectorId);
    expect(validatePlainLines(engineLines(summary), reference)).toEqual([]);
  });

  it.each(LLM_CASES.map((item) => item.detectorId))('%s: 말만 바꾸고 숫자·이름을 지키면 통과한다', (detectorId) => {
    const { summary, reference } = referenceOf(detectorId);
    const lines = Object.fromEntries(Object.entries(engineLines(summary)).map(([key, text]) => [key, `확인 결과, ${text}`]));
    expect(validatePlainLines(lines, reference)).toEqual([]);
  });

  it('엔진에 없는 숫자를 넣으면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), what: `${summary.what} 교체 비용은 1,200만 원입니다.` }, reference);
    expect(issues.map((issue) => issue.code)).toContain('untracked_number');
  });

  it('엔진 수치를 빠뜨리면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), what: '배터리 랙 1(RACK01)에 담기는 전기의 양이 줄었습니다.' }, reference);
    expect(issues.map((issue) => issue.code)).toContain('missing_number');
  });

  it('표시 반올림은 허용한다 (6.2% → 6%)', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const shortened = summary.what.replace(/(\d+)\.\d+%/, '$1%');
    expect(shortened).not.toBe(summary.what);
    expect(validatePlainLines({ ...engineLines(summary), what: shortened }, reference)).toEqual([]);
  });

  it('방향을 뒤집으면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const flipped = summary.what.replace('줄었습니다', '늘었습니다');
    const issues = validatePlainLines({ ...engineLines(summary), what: flipped }, reference);
    expect(issues.map((issue) => issue.code)).toContain('direction_mismatch');
  });

  it('숫자 집합은 그대로 두고 비교 횟수만 서로 바꿔 붙이면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.cell_imbalance');
    const swapped = (summary.basis ?? '').replace(/예전 (\S+?)번, 최근 (\S+?)번/u, '예전 $2번, 최근 $1번');
    expect(swapped).not.toBe(summary.basis);
    const issues = validatePlainLines({ ...engineLines(summary), basis: swapped }, reference);
    expect(issues.map((issue) => issue.code)).toContain('number_label_mismatch');
  });

  it('엔진이 낸 할 일을 하지 않아도 된다고 뒤집으면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), nextStep: '정기 용량시험 결과와 비교하지 않아도 됩니다.' }, reference);
    expect(issues.some((issue) => issue.code === 'forbidden_expression' && issue.message.includes('지시를 뒤집는'))).toBe(true);
  });

  it('설비 이름을 빠뜨리면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), what: summary.what.replace('(RACK01)', '') }, reference);
    expect(issues.map((issue) => issue.code)).toContain('missing_label');
  });

  it.each([
    ['원인은 셀 열화입니다.', '원인을 단정하는 표현'],
    ['셀이 늙었기 때문입니다.', '원인을 단정하는 표현'],
    ['즉시 운전을 정지하세요.', '안전 판단을 대신하는 정지 지시'],
    ['제조사에 손해 배상을 청구하세요.', '법적 조언'],
    ['이 설비는 안전합니다.', '설비가 안전하다고 단정하는 표현'],
  ])('금지 표현을 넣으면 거부한다: %s', (added, reason) => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), outlook: `${summary.outlook} ${added}` }, reference);
    expect(issues.some((issue) => issue.code === 'forbidden_expression' && issue.message.includes(reason))).toBe(true);
  });

  it('안전 고정 문구를 지우면 거부한다', () => {
    const { summary, reference } = referenceOf('tank.static_leak');
    expect(summary.outlook).toContain(SAFETY_DECISION_NOTICE);
    const issues = validatePlainLines({ ...engineLines(summary), outlook: (summary.outlook ?? '').replace(SAFETY_DECISION_NOTICE, '') }, reference);
    expect(issues.map((issue) => issue.code)).toContain('safety_notice_missing');
  });

  it('줄을 빼먹거나 새로 만들면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const lines = engineLines(summary);
    expect(validatePlainLines({ ...lines, what: '' }, reference).map((issue) => issue.code)).toContain('missing_line');
    expect(validatePlainLines({ what: lines.what }, reference).map((issue) => issue.code)).toContain('missing_line');
  });

  it('엔진 문장보다 지나치게 길면 거부한다', () => {
    const { summary, reference } = referenceOf('ess.capacity_fade');
    const issues = validatePlainLines({ ...engineLines(summary), what: `${summary.what}${' 같은 내용을 되풀이합니다.'.repeat(20)}` }, reference);
    expect(issues.map((issue) => issue.code)).toContain('too_long');
  });
});
