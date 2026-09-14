// 효과 방향 단어 (순수): 템플릿이 효과 부호로 증가/감소 단어를 만들고, validateDraft가 편집으로 뒤집힌 방향 단어를 찾는다.
// 규칙
//   - 방향 = 효과 값 부호 × 메트릭 극성. v_cell_decay_rate(연료전지 감쇠율)는 양수가 전압 감소, 나머지는 양수가 증가.
//     데이터 품질 메트릭(dq.*)과 0은 방향을 따지지 않는다.
//   - 검사 범위: 본문에서 그 발견사항 effect.value 토큰이 처음 나온 곳부터 그 문장 끝('다.')까지.
//     그 안에 반대 방향 단어가 있으면 불일치 (같은 방향 다른 표현 '줄었습니다'·중립 '변했습니다'는 허용).
import type { EvidencePack } from './pack-types';
import type { NumberToken } from './composer';

export type EffectDirection = 'increase' | 'decrease';

const DECREASE_POSITIVE_METRICS: readonly string[] = ['v_cell_decay_rate'];

export const DIRECTION_WORDS: Readonly<Record<EffectDirection, readonly string[]>> = {
  increase: ['증가', '상승', '늘었', '늘어', '커졌', '커지', '높아', '올랐', '오르'],
  decrease: ['감소', '하락', '하강', '줄었', '줄어', '작아', '낮아', '떨어'],
};

/** 효과가 가리키는 방향. 방향을 따지지 않는 메트릭·0·값 없음이면 null */
export function effectDirection(metric: string, value: number | null): EffectDirection | null {
  if (value === null || !Number.isFinite(value) || value === 0 || metric.startsWith('dq.')) return null;
  const positive = value > 0;
  const decreasePositive = DECREASE_POSITIVE_METRICS.includes(metric);
  return positive !== decreasePositive ? 'increase' : 'decrease';
}

/** 템플릿 동사: '증가했습니다' · '감소했습니다' (방향이 없으면 '변했습니다') */
export function directionVerb(direction: EffectDirection | null, form: 'past' | 'progressive' = 'past'): string {
  if (direction === null) return form === 'past' ? '변했습니다' : '변하고 있습니다';
  const stem = direction === 'increase' ? '증가' : '감소';
  return form === 'past' ? `${stem}했습니다` : `${stem}하고 있습니다`;
}

const EFFECT_VALUE_PATH = /^findings\[(\d+)\]\.effect\.value$/;

export interface DirectionIssue {
  readonly findingId: string;
  readonly expected: EffectDirection;
  readonly found: string;
}

/** 블록 본문에서 효과 값 뒤 같은 문장 안의 반대 방향 단어 */
export function directionIssues(block: { readonly text: string; readonly numberTokens: readonly NumberToken[] }, pack: EvidencePack): DirectionIssue[] {
  return block.numberTokens.flatMap((token): DirectionIssue[] => {
    const match = EFFECT_VALUE_PATH.exec(token.path);
    const finding = match ? pack.findings[Number(match[1])] : undefined;
    const expected = finding ? effectDirection(finding.effect.metric, finding.effect.value) : null;
    const at = block.text.indexOf(token.text);
    if (!finding || expected === null || at < 0) return [];
    const end = block.text.indexOf('다.', at);
    const sentence = block.text.slice(at, end < 0 ? undefined : end + 2);
    const opposite = DIRECTION_WORDS[expected === 'increase' ? 'decrease' : 'increase'];
    const found = opposite.find((word) => sentence.includes(word));
    return found ? [{ findingId: finding.id, expected, found }] : [];
  });
}
