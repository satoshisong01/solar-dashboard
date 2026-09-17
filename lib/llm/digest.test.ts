// 종합 요약 생성 흐름: 숫자 집합만 맞춘 답도 채택하지 않고 엔진이 만든 틀 문장으로 되돌아간다.
// 조작 시나리오 다섯 가지(건수 맞바꿈·라벨 바꿔치기·지시 반전·엔진에 없는 숫자·방향 단어)를 모두 고정한다.
import { describe, expect, it } from 'vitest';
import { buildDigestStats, digestTemplate, openFindingsFor } from '@/lib/desk/digest';
import { DIGEST_ROWS } from '@/lib/desk/digest/test-fixtures';
import { explainDigest } from './digest';
import { engineDigestLines } from './digest-prompt';
import { fakeProvider, jsonReply } from './test-fixtures';
import type { DigestLineKey } from './types';

const stats = buildDigestStats(openFindingsFor(DIGEST_ROWS, null), null);
const template = digestTemplate(stats);
const engine = engineDigestLines(template);

/** 엔진 문장에서 고른 줄만 바꿔 답하게 한다 */
const answer = (patch: Readonly<Partial<Record<DigestLineKey, string>>>) => explainDigest({ stats, template }, fakeProvider(jsonReply({ ...engine, ...patch })));

describe('explainDigest', () => {
  it('엔진이 만든 문장이 검사 대상과 같은 사실을 말한다', () => {
    expect(engine.breakdown).toBe('계통별로 보면 배터리 4건, 전해조 1건, 데이터 품질 1건입니다.');
    expect(engine.urgency).toContain('바로 확인 3건, 이번 주 확인 1건, 지켜보기 2건');
    expect(engine.nextStep).toContain('바로 확인 3건은 오늘 안에 근거를 열어 확인하세요.');
  });

  it('말만 바꾸고 사실을 지킨 답은 채택한다', async () => {
    const result = await answer({ headline: `확인해 보니 ${engine.headline}` });
    expect(result.source).toBe('llm');
    expect(result.summary.headline).toBe(`확인해 보니 ${engine.headline}`);
    expect(result.validation.issues).toEqual([]);
  });

  it.each([
    ['계통별 건수를 서로 바꿔 붙이면', { breakdown: '계통별로 보면 배터리 1건, 전해조 4건, 데이터 품질 1건입니다.' }],
    ['급함별 건수를 서로 바꿔 붙이면', { urgency: '급한 정도로 나누면 바로 확인 1건, 이번 주 확인 3건, 지켜보기 2건입니다. 그중 가장 먼저 볼 건은 랙 1(RACK01)에서 잡혔습니다.' }],
  ])('%s 거부하고 틀 문장으로 되돌아간다', async (_label, patch) => {
    const result = await answer(patch);
    expect(result.source).toBe('template');
    expect(result.summary).toEqual(template);
    expect(result.validation.reason).toBe('rejected');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('number_label_mismatch');
  });

  it('라벨을 엔진에 없던 이름으로 바꾸면 거부한다', async () => {
    const result = await answer({ breakdown: '계통별로 보면 태양광 4건, 전해조 1건, 데이터 품질 1건입니다.' });
    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('missing_label');
  });

  it('숫자는 그대로 두고 지시를 뒤집으면 거부한다', async () => {
    const result = await answer({ nextStep: '바로 확인 3건은 오늘 확인하지 않아도 됩니다. 이번 주 확인 1건은 이번 주 안에 보고, 지켜보기 2건은 다음에 봐도 됩니다.' });
    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('forbidden_expression');
  });

  it('엔진이 세지 않은 숫자를 넣으면 거부한다', async () => {
    const result = await answer({ headline: `${engine.headline} 지난주보다 3건 늘었습니다.` });
    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('untracked_number');
  });

  it('엔진이 말하지 않은 방향(늘었다·줄었다)을 새로 쓰면 거부한다', async () => {
    const result = await answer({ breakdown: '계통별로 보면 배터리 4건, 전해조 1건, 데이터 품질 1건으로 줄었습니다.' });
    expect(result.source).toBe('template');
    expect(result.validation.issues.map((issue) => issue.code)).toContain('direction_mismatch');
  });

  it('제공자가 없으면 부르지 않고 틀 문장을 그대로 쓴다', async () => {
    const result = await explainDigest({ stats, template }, null);
    expect(result.source).toBe('template');
    expect(result.validation.reason).toBe('no_key');
    expect(result.summary).toEqual(template);
  });
});
