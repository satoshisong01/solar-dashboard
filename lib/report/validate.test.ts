import { describe, expect, it } from 'vitest';
import type { ReportDraft } from './composer';
import { buildEvidencePack } from './evidence-pack';
import type { EvidencePack } from './pack-types';
import { templateComposer } from './template-composer';
import { capacityFinding, packInput, stackFinding } from './test-fixtures';
import { forbiddenReasons, validateDraft, type ValidatableDraft } from './validate';

const setup = (): { pack: EvidencePack; draft: ReportDraft } => {
  const pack = buildEvidencePack(packInput());
  return { pack, draft: templateComposer.compose(pack) };
};

type BlockChange = (block: ValidatableDraft['sections'][number]['blocks'][number]) => ValidatableDraft['sections'][number]['blocks'][number];

const withBlock = (draft: ReportDraft, blockId: string, change: BlockChange): ValidatableDraft => ({
  ...draft,
  sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => (b.id === blockId ? change(b) : b)) })),
});

const codes = (result: ReturnType<typeof validateDraft>): string[] => result.issues.map((i) => i.code);

describe('validateDraft', () => {
  it('수치 불일치: 토큰 글자가 팩 값과 다르면 token_value, 본문 숫자만 바꾸면 untracked·missing', () => {
    const { pack, draft } = setup();
    const tokenChanged = withBlock(draft, 'finding.1.message', (b) => ({ ...b, text: b.text.replace('−7.4%', '−8.4%'), numberTokens: b.numberTokens.map((t) => (t.text === '−7.4' ? { ...t, text: '−8.4' } : t)) }));
    expect(codes(validateDraft(tokenChanged, pack))).toEqual(['token_value']);
    const textChanged = withBlock(draft, 'finding.1.message', (b) => ({ ...b, text: b.text.replace('586.5 Ah', '600 Ah') }));
    const result = validateDraft(textChanged, pack);
    expect(codes(result)).toEqual(['untracked_number', 'missing_number']);
    expect(result.issues[0]).toMatchObject({ blockId: 'finding.1.message', message: expect.stringContaining('"600"') });
  });

  it('방향 단어: 효과 값 뒤 같은 문장의 방향이 부호와 반대면 direction_mismatch (같은 방향 다른 표현·다른 문장의 단어는 허용)', () => {
    const { pack, draft } = setup();
    const flipped = withBlock(draft, 'finding.1.message', (b) => ({ ...b, text: b.text.replace('감소했습니다.', '증가했습니다.') }));
    const result = validateDraft(flipped, pack);
    expect(codes(result)).toEqual(['direction_mismatch']);
    expect(result.issues[0]?.message).toContain('"증가"');
    const synonym = withBlock(draft, 'finding.1.message', (b) => ({ ...b, text: b.text.replace('감소했습니다.', '줄었습니다.') }));
    expect(validateDraft(synonym, pack).ok).toBe(true);
    const stack = buildEvidencePack(packInput({ findings: [stackFinding()] }));
    const stackDraft = templateComposer.compose(stack);
    const withLabel = withBlock(stackDraft, 'finding.4.message', (b) => ({ ...b, text: `${b.text} 함께 확인된 신호: 셀 전압 감소 동반.` }));
    expect(validateDraft(withLabel, stack).ok).toBe(true);
    const stackFlipped = withBlock(stackDraft, 'finding.4.message', (b) => ({ ...b, text: b.text.replace('로 상승하고 있습니다.', '로 하락하고 있습니다.') }));
    expect(codes(validateDraft(stackFlipped, stack))).toEqual(['direction_mismatch']);
  });

  it('표시 반올림은 허용한다 (−7.396 → −7.40 표기)', () => {
    const { pack, draft } = setup();
    const rounded = withBlock(draft, 'finding.1.message', (b) => ({ ...b, text: b.text.replace('−7.4%', '−7.40%'), numberTokens: b.numberTokens.map((t) => (t.text === '−7.4' ? { ...t, text: '−7.40' } : t)) }));
    expect(validateDraft(rounded, pack).ok).toBe(true);
  });

  it('없는 경로·없는 인용 id', () => {
    const { pack, draft } = setup();
    const badPath = withBlock(draft, 'summary.overview', (b) => ({ ...b, numberTokens: b.numberTokens.map((t, i) => (i === 1 ? { ...t, path: 'stats.nothing' } : t)) }));
    expect(codes(validateDraft(badPath, pack))).toContain('token_path');
    const badCitation = withBlock(draft, 'finding.1.advice', (b) => ({ ...b, citations: ['finding:999'] }));
    expect(validateDraft(badCitation, pack).issues).toEqual([{ code: 'citation_missing', blockId: 'finding.1.advice', message: '인용 근거 finding:999이(가) 팩에 없습니다' }]);
  });

  it('심각도 4 이상 발견사항을 인용한 블록을 모두 빼면 severity_not_mentioned', () => {
    const pack = buildEvidencePack(packInput({ findings: [capacityFinding(), stackFinding()] }));
    const draft = templateComposer.compose(pack);
    const excluded: ValidatableDraft = { ...draft, sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => (b.citations.includes('finding:4') ? { ...b, included: false, excludeReason: '다음 달 리포트로' } : b)) })) };
    const result = validateDraft(excluded, pack);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: 'severity_not_mentioned', blockId: null, message: '심각도 4 발견사항 #4(SIM-B/ELZ1/STACK1)을 언급한 블록이 없습니다' }]);
  });

  it('금지 표현: 안전 보장·법정 안전 판단 대체 (고정 문구의 부정문은 허용)', () => {
    const { pack, draft } = setup();
    const unsafe = withBlock(draft, 'finding.1.advice', (b) => ({ ...b, text: `${b.text} 이 조치로 설비는 안전합니다.` }));
    expect(codes(validateDraft(unsafe, pack))).toEqual(['forbidden_expression']);
    expect(forbiddenReasons('이 분석으로 법정 안전설비 점검을 대체할 수 있습니다')).toEqual(['법정 안전 판단을 대체한다는 표현']);
    expect(forbiddenReasons('수소 누출이 없습니다')).toHaveLength(1);
    expect(forbiddenReasons('이 리포트는 법정 안전설비·현장 PLC 인터록 판단을 대체하지 않습니다.')).toEqual([]);
  });

  it('안전 고정 문구를 빼거나 바꾸면 safety_notice_missing, 제외 사유가 없으면 exclude_reason_missing', () => {
    const { pack, draft } = setup();
    const noSafety = withBlock(draft, 'safety.notice', (b) => ({ ...b, text: '참고용 리포트입니다.' }));
    expect(codes(validateDraft(noSafety, pack))).toEqual(['safety_notice_missing']);
    const noReason = withBlock(draft, 'kpi.pv.kwh', (b) => ({ ...b, included: false, excludeReason: '  ' }));
    expect(codes(validateDraft(noReason, pack))).toEqual(['exclude_reason_missing']);
  });

  it('팩 내용이 바뀌었거나 다른 팩의 초안이면 pack_hash_mismatch', () => {
    const { pack, draft } = setup();
    const tampered: EvidencePack = { ...pack, stats: { ...pack.stats, severeCount: 0 } };
    expect(codes(validateDraft(draft, tampered))).toContain('pack_hash_mismatch');
    expect(codes(validateDraft({ ...draft, packHash: 'ffff' }, pack))).toEqual(['pack_hash_mismatch']);
  });

  it('제외한 블록은 숫자 검사를 하지 않는다', () => {
    const { pack, draft } = setup();
    const excluded = withBlock(draft, 'kpi.pv.kwh', (b) => ({ ...b, text: '999', included: false, excludeReason: '중복' }));
    expect(validateDraft(excluded, pack).ok).toBe(true);
  });
});
