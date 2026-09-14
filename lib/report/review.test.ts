import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from './evidence-pack';
import { editBlockText, findBlock, parseReviewDraft, reportedFindingIds, setBlockInclusion, toReviewDraft, tokenPreservationError } from './review';
import { templateComposer } from './template-composer';
import { packInput } from './test-fixtures';
import { validateDraft } from './validate';

const ADMIN = 'admin@hysol.local';
const NOW = Date.UTC(2026, 8, 15);
const pack = buildEvidencePack(packInput());
const review = toReviewDraft(templateComposer.compose(pack));
const MESSAGE = 'finding.1.message';
const original = findBlock(review, MESSAGE)?.text ?? '';

describe('숫자 토큰 잠금 편집', () => {
  it('숫자·이름을 그대로 두고 문장만 바꾸면 저장되고 검증도 통과한다 (원본 초안은 그대로)', () => {
    const edited = original.replace('으로 충전을 비교하면', '에서 충전 세션을 맞춰 보면').replace(' 감소했습니다.', ' 줄었습니다.');
    const result = editBlockText(review, MESSAGE, edited, ADMIN, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findBlock(result.draft, MESSAGE)).toMatchObject({ text: edited, originalText: original, editedBy: ADMIN, editedAt: NOW });
    expect(findBlock(review, MESSAGE)?.text).toBe(original);
    expect(validateDraft(result.draft, pack).ok).toBe(true);
  });

  it('숫자를 바꾸거나 지우거나 더하면 거절한다', () => {
    const changed = editBlockText(review, MESSAGE, original.replace('586.5', '590.0'), ADMIN, NOW);
    expect(changed).toEqual({ ok: false, error: expect.stringMatching(/^숫자는 편집할 수 없습니다\. .*"586\.5".*"590\.0"/) });
    expect(editBlockText(review, MESSAGE, original.replace(' 59 A 기준 환산 충전시간은 10h 00m → 9h 16m입니다.', ''), ADMIN, NOW).ok).toBe(false);
    expect(editBlockText(review, MESSAGE, `${original} 약 3주 뒤 재확인.`, ADMIN, NOW).ok).toBe(false);
  });

  it('숫자 순서를 바꾸는 편집은 허용한다 (값·개수 보존)', () => {
    const tokens = findBlock(review, 'todo.1')?.numberTokens ?? [];
    expect(tokenPreservationError(tokens, '[SIM-B/ELZ1/STACK1] 전해조 셀 전압 상승 +21.4 µV/h: OCV 대기 최소화·램프율 제한 (1순위, 신뢰도 99%, 심각도 4)')).toBeNull();
  });

  it('이름 토큰(설비 경로)을 지우면 거절, 고정 문구 블록은 편집·제외 불가', () => {
    expect(editBlockText(review, MESSAGE, original.replace('[SIM-A/ESS1/RACK01] ', ''), ADMIN, NOW)).toEqual({ ok: false, error: expect.stringContaining('SIM-A/ESS1/RACK01') });
    expect(editBlockText(review, 'safety.notice', '참고용입니다.', ADMIN, NOW)).toEqual({ ok: false, error: '고정 문구는 편집할 수 없습니다' });
    expect(setBlockInclusion(review, 'safety.notice', false, '불필요', ADMIN, NOW).ok).toBe(false);
  });

  it('빈 문장·너무 긴 문장·없는 블록', () => {
    expect(editBlockText(review, MESSAGE, '   ', ADMIN, NOW)).toEqual({ ok: false, error: '문장을 입력하세요' });
    expect(editBlockText(review, MESSAGE, 'a'.repeat(2_001), ADMIN, NOW).ok).toBe(false);
    expect(editBlockText(review, 'nope', 'x', ADMIN, NOW)).toEqual({ ok: false, error: '블록을 찾을 수 없습니다' });
  });
});

describe('블록 포함·제외와 승인 대상 발견사항', () => {
  it('제외는 사유가 필요하고, 제외한 발견사항은 in_report 대상에서 빠진다', () => {
    expect(reportedFindingIds(review)).toEqual(['1', '2', '3', '4', '7']);
    expect(setBlockInclusion(review, MESSAGE, false, ' ', ADMIN, NOW)).toEqual({ ok: false, error: '제외 사유를 입력하세요' });
    const noReport = ['finding.3.message', 'finding.3.advice'].reduce((draft, id) => {
      const result = setBlockInclusion(draft, id, false, '현장 확인 전', ADMIN, NOW);
      return result.ok ? result.draft : draft;
    }, review);
    expect(findBlock(noReport, 'finding.3.message')).toMatchObject({ included: false, excludeReason: '현장 확인 전' });
    expect(reportedFindingIds(noReport)).toEqual(['1', '2', '4', '7']);
    const back = setBlockInclusion(noReport, 'finding.3.message', true, null, ADMIN, NOW);
    expect(back.ok && findBlock(back.draft, 'finding.3.message')?.excludeReason).toBeNull();
  });

  it('저장한 jsonb를 다시 읽는다. 형식이 깨졌으면 null', () => {
    expect(parseReviewDraft(JSON.parse(JSON.stringify(review)))).toEqual(review);
    expect(parseReviewDraft({ composerId: 'x', packHash: 'y', sections: [{ kind: 'weird', blocks: [] }] })).toBeNull();
    expect(parseReviewDraft(null)).toBeNull();
  });
});
