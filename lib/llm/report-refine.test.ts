// 리포트 초안 다듬기: 통과한 블록만 갈아 끼우고, 고정 블록은 건드리지 않으며, 숫자 잠금(validateDraft)은 그대로 통과한다.
import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '@/lib/report/evidence-pack';
import { SAFETY_NOTICE, URGENT_BLOCK_ID, type DraftBlock, type ReportDraft } from '@/lib/report/composer';
import { packInput } from '@/lib/report/test-fixtures';
import { templateComposer, TEMPLATE_COMPOSER_ID } from '@/lib/report/template-composer';
import { validateDraft } from '@/lib/report/validate';
import { LLM_COMPOSER_ID, refineDraft } from './report-refine';
import { fakeProvider } from './test-fixtures';
import type { LlmOutcome } from './types';

const PACK = buildEvidencePack(packInput());
const DRAFT = templateComposer.compose(PACK);
const blocksOf = (draft: ReportDraft): readonly DraftBlock[] => draft.sections.flatMap((section) => section.blocks);
const textOf = (draft: ReportDraft, id: string): string => blocksOf(draft).find((block) => block.id === id)?.text ?? '';

/** 받은 블록마다 map으로 새 본문을 만들어 주는 가짜 응답 */
const replyWith = (change: (block: DraftBlock) => string): LlmOutcome => ({
  ok: true,
  text: JSON.stringify({ blocks: blocksOf(DRAFT).map((block) => ({ id: block.id, text: change(block) })) }),
});

const enabled = (reply: LlmOutcome) => ({ provider: fakeProvider(reply, 'fake-flash'), enabled: true });

describe('refineDraft', () => {
  it('말만 바꾼 블록은 갈아 끼우고 composer id로 출처를 남긴다', async () => {
    const refined = await refineDraft(DRAFT, PACK, enabled(replyWith((block) => `정리하면, ${block.text}`)));

    expect(refined.composerId).toBe(LLM_COMPOSER_ID);
    expect(textOf(refined, 'summary.overview')).toBe(`정리하면, ${textOf(DRAFT, 'summary.overview')}`);
    expect(refined.packHash).toBe(DRAFT.packHash);
    // 숫자 토큰·인용을 그대로 두므로 리포트 검증은 그대로 통과한다
    expect(validateDraft(refined, PACK)).toMatchObject({ ok: true, issues: [] });
  });

  it('안전 고정 문구와 즉시 확인 필요 블록은 보내지도, 바꾸지도 않는다', async () => {
    const options = enabled(replyWith(() => '아무 말이나 씁니다.'));

    const refined = await refineDraft(DRAFT, PACK, options);

    expect(textOf(refined, 'safety.notice')).toBe(SAFETY_NOTICE);
    expect(textOf(refined, URGENT_BLOCK_ID)).toBe(textOf(DRAFT, URGENT_BLOCK_ID));
    const sent = JSON.parse(options.provider.requests[0]?.user ?? '{}');
    const sentIds = (sent.blocks as { id: string }[]).map((block) => block.id);
    expect(sentIds).not.toContain(URGENT_BLOCK_ID);
    expect(sentIds).not.toContain('safety.notice');
  });

  it('숫자를 빠뜨리거나 새로 만든 블록은 원문을 그대로 둔다', async () => {
    const refined = await refineDraft(DRAFT, PACK, enabled(replyWith((block) => (block.id === 'summary.overview' ? '이번 달은 대체로 괜찮았습니다.' : `${block.text} 추가 비용 1,200만 원이 듭니다.`))));

    expect(blocksOf(refined).map((block) => block.text)).toEqual(blocksOf(DRAFT).map((block) => block.text));
    expect(refined.composerId).toBe(TEMPLATE_COMPOSER_ID);
  });

  it('한 블록이 걸려도 나머지는 살린다', async () => {
    const refined = await refineDraft(DRAFT, PACK, enabled(replyWith((block) => (block.id === 'summary.overview' ? '숫자를 지운 문장입니다.' : `정리하면, ${block.text}`))));

    expect(textOf(refined, 'summary.overview')).toBe(textOf(DRAFT, 'summary.overview'));
    expect(textOf(refined, 'summary.energy')).toBe(`정리하면, ${textOf(DRAFT, 'summary.energy')}`);
    expect(refined.composerId).toBe(LLM_COMPOSER_ID);
    expect(validateDraft(refined, PACK)).toMatchObject({ ok: true, issues: [] });
  });

  it('금지 표현을 넣으면 그 블록은 되돌린다', async () => {
    const refined = await refineDraft(DRAFT, PACK, enabled(replyWith((block) => (block.id === 'summary.energy' ? `${block.text} 이 설비는 안전합니다.` : block.text))));

    expect(textOf(refined, 'summary.energy')).toBe(textOf(DRAFT, 'summary.energy'));
  });

  it('AI를 끄거나 키가 없으면 부르지 않고 그대로 돌려준다', async () => {
    const off = { provider: fakeProvider(replyWith((block) => `정리하면, ${block.text}`)), enabled: false };

    expect(await refineDraft(DRAFT, PACK, off)).toBe(DRAFT);
    expect(off.provider.requests).toHaveLength(0);
    expect(await refineDraft(DRAFT, PACK, { provider: null, enabled: true })).toBe(DRAFT);
  });

  it('호출·응답 읽기에 실패하면 그대로 돌려준다', async () => {
    expect(await refineDraft(DRAFT, PACK, enabled({ ok: false, reason: 'timeout', detail: '20000ms' }))).toBe(DRAFT);
    expect(await refineDraft(DRAFT, PACK, enabled({ ok: true, text: '문장만 돌려줬습니다' }))).toBe(DRAFT);
  });
});
