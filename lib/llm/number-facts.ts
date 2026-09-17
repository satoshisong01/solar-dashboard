// 숫자와 그 숫자를 가리키는 말의 짝 (순수). 엔진 문장에서 짝을 뽑고, 다시 쓴 문장에서 그 짝이 어긋났는지 본다.
//
// 왜 필요한가: 줄마다 숫자 집합만 견주면 LLM이 건수를 서로 바꿔 붙여도("배터리 1건, 전해조 4건") 통과한다.
// 짝은 엔진 문장에서 뽑는다 — 틀 문장이 곧 사실의 출처이므로 표를 따로 손으로 적어 두는 것보다 어긋날 일이 없다.
//
// 한국어라서 두는 규칙
//   - 라벨은 숫자 앞에 오는 일이 많고('배터리 4건', '예전 20번') 뒤에 올 수도 있다('5건은 아직 분류하지 않은') — 양쪽을 본다.
//   - 단위·지시어('건', '개', '모두', '그중', '아직')는 그 숫자가 무엇을 센 것인지 말해 주지 않으므로 라벨로 쓰지 않는다.
//   - 라벨 뒤 조사는 떼고 본다('발견사항은' → '발견사항').
//
// 확실한 것만 건다 (자연어를 다 이해할 수는 없다)
//   - 라벨이 문장에서 사라졌거나 라벨 옆에 숫자가 없으면 판단하지 않는다.
//   - 라벨이 여러 번 나오면 그중 한 번이라도 짝이 맞으면 통과시킨다.
import { displayNumbersMatch, NUMERIC_PATTERN } from '@/lib/report/tokens';

/** 숫자 하나와 엔진 문장에서 그 숫자를 가리키던 말 */
export interface NumberFact {
  /** 엔진이 쓴 표시 문자열 ('7', '1,200') */
  readonly value: string;
  /** 문장에서 이 숫자를 가리키는 말 ('이번 주 확인') */
  readonly label: string;
}

/** 라벨과 숫자가 이만큼 넘게 떨어져 있으면 짝으로 보지 않는다 (글자 수) */
const MAX_GAP = 20;
/** 라벨이 문장 안에서 겹칠 때 옆으로 더 붙여 볼 낱말 수 ('확인' → '바로 확인') */
const MAX_EXTEND = 2;

/** 숫자 옆에 있어도 그 숫자가 무엇을 센 것인지 말해 주지 않는 말: 단위·수량·지시어 (조사·어미가 붙은 꼴까지) */
const NON_LABEL =
  /^(?:건|개|명|번|대|일|시간|분|초|원|쌍|회|점|도|%|kg|kWh|kW|mV|mΩ|mbar|W|L|쯤|약|총|모두|그중|중|가운데|각각|가장|더|덜|또|및|등|것|수|때|뒤|앞|안|위|아직|이미|지금|오늘|이번|다음|최대|최소|평균|합계|각|매|같은|다른|이런|그런|어떤|있는|있고|없는|없고|않은|않는|않고|않아|되는|하는)(?:입니다|이고|이며|은|는|이|가|을|를|의|에|에서|도|만|씩|과|와|까지|부터|으로|로)*$/u;

/** 라벨 끝에 붙는 조사 (떼고도 두 글자가 남을 때만 뗀다 — '온도'를 '온'으로 만들지 않는다) */
const TAIL_PARTICLE = /(?:입니다|이고|이며|에서|으로|은|는|이|가|을|를|의|에|과|와|도|만|씩|로)$/u;

/** 낱말 경계로 쓰는 구두점 */
const WORD_PATTERN = /[^\s,.()[\]"'·—~]+/gu;

interface Span {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 숫자가 든 이름(설비 코드 '배터리 랙 1(RACK01)')을 같은 길이의 공백으로 덮는다.
 * 자리를 그대로 두어야 라벨과 숫자 사이 거리를 잴 수 있다. 숫자가 없는 이름은 라벨 후보라서 덮지 않는다.
 */
export function maskNamedNumbers(text: string, labels: readonly string[]): string {
  return [...labels]
    .filter((label) => label !== '' && /\d/u.test(label))
    .sort((a, b) => b.length - a.length)
    .reduce((rest, label) => rest.split(label).join(' '.repeat(label.length)), text);
}

const spansOf = (text: string, pattern: RegExp): Span[] => [...text.matchAll(pattern)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));

/** 숫자 자리를 지우고 남는 낱말 (숫자 안의 글자는 낱말로 세지 않는다) */
function wordSpans(masked: string, numbers: readonly Span[]): Span[] {
  const blanked = numbers.reduce((text, number) => `${text.slice(0, number.start)}${' '.repeat(number.end - number.start)}${text.slice(number.end)}`, masked);
  return spansOf(blanked, WORD_PATTERN);
}

/** 이 자리에서 가장 가까운 숫자 (너무 멀면 없는 것으로 본다) */
function nearestNumber(numbers: readonly Span[], start: number, length: number): Span | null {
  const end = start + length;
  const gap = (number: Span): number => (number.start >= end ? number.start - end : start - number.end);
  return [...numbers].filter((number) => gap(number) >= 0 && gap(number) <= MAX_GAP).sort((a, b) => gap(a) - gap(b) || a.start - b.start)[0] ?? null;
}

function occurrences(text: string, needle: string, from = 0): number[] {
  const at = text.indexOf(needle, from);
  return at < 0 ? [] : [at, ...occurrences(text, needle, at + 1)];
}

const isLabelWord = (word: string): boolean => word.length >= 2 && !NON_LABEL.test(word);

const stripTail = (label: string): string => {
  const cut = label.replace(TAIL_PARTICLE, '');
  return cut.length >= 2 ? cut : label;
};

/** 숫자 한쪽(앞 또는 뒤)에서 라벨로 쓸 만한 말들. 가까운 것부터, 겹치면 옆 낱말을 더 붙인 꼴까지 */
function labelCandidates(masked: string, words: readonly Span[], side: 'left' | 'right'): string[] {
  const ordered = side === 'left' ? [...words].reverse() : words; // 숫자에서 가까운 순
  const first = ordered.findIndex((word) => isLabelWord(word.text));
  if (first < 0) return [];
  const near = ordered[first];
  return Array.from({ length: Math.min(MAX_EXTEND + 1, ordered.length - first) }, (_, extend) => {
    const far = ordered[first + extend];
    return side === 'left' ? masked.slice(far.start, near.end) : masked.slice(near.start, far.end);
  });
}

/** 엔진 문장에서 이 말이 딱 한 번 나오고, 그 옆의 가장 가까운 숫자가 이 값인가 */
const pairs = (masked: string, numbers: readonly Span[], label: string, value: string): boolean => {
  const spots = occurrences(masked, label);
  return spots.length === 1 && nearestNumber(numbers, spots[0], label.length)?.text === value;
};

/**
 * 엔진 문장에서 숫자마다 짝이 되는 말을 뽑는다. 짝을 고를 수 없는 숫자는 건너뛴다 (검사하지 않는다).
 * 뽑은 짝은 엔진 문장에서 반드시 성립하므로, 엔진 문장 그대로인 답은 언제나 통과한다.
 */
export function numberFacts(engineText: string, labels: readonly string[]): NumberFact[] {
  const masked = maskNamedNumbers(engineText, labels);
  const numbers = spansOf(masked, NUMERIC_PATTERN);
  const words = wordSpans(masked, numbers);
  const between = (from: number, to: number): Span[] => words.filter((word) => word.start >= from && word.end <= to);

  return numbers.flatMap((number, index): NumberFact[] => {
    const left = labelCandidates(masked, between(numbers[index - 1]?.end ?? 0, number.start), 'left');
    const right = labelCandidates(masked, between(number.end, numbers[index + 1]?.start ?? masked.length), 'right');
    const label = [...left, ...right].flatMap((candidate) => [stripTail(candidate), candidate]).find((candidate) => pairs(masked, numbers, candidate, number.text));
    return label === undefined ? [] : [{ value: number.text, label }];
  });
}

/** 다시 쓴 문장에서 라벨 옆 숫자가 엔진과 다른 짝 (확실한 것만) */
export function mismatchedFacts(candidate: string, facts: readonly NumberFact[], labels: readonly string[]): NumberFact[] {
  if (facts.length === 0) return [];
  const masked = maskNamedNumbers(candidate, labels);
  const numbers = spansOf(masked, NUMERIC_PATTERN);
  return facts.filter((fact) => {
    const near = occurrences(masked, fact.label).flatMap((at): Span[] => {
      const number = nearestNumber(numbers, at, fact.label.length);
      return number === null ? [] : [number];
    });
    return near.length > 0 && !near.some((number) => displayNumbersMatch(number.text, fact.value));
  });
}
