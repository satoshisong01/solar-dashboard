// 생성 문장 검증 (순수). 리포트 초안 검증(lib/report/validate.ts·tokens.ts·direction.ts)의 규칙을 그대로 가져와
// 줄 단위 요약(발견사항 쉬운 말 4줄·분석 데스크 종합 요약 4줄)에 맞게 넓힌다.
// 하나라도 걸리면 그 문장은 채택하지 않고 틀 문장으로 되돌린다.
//   1) 숫자·날짜: 엔진 문장에 있는 것만, 개수까지 같게 (표시 반올림 허용)
//   2) 이름: 엔진 문장에 있던 설비·사이트 이름이 그대로 있어야 한다
//   3) 방향: 엔진 문장에 없던 반대 방향 단어를 새로 넣지 못한다
//   4) 금지 표현: 리포트 금지 목록 + 원인 단정·안전 판단 대체·법적 조언
//   5) 안전 고정 문구: 엔진 문장에 있으면 글자 그대로 남아야 한다
//   6) 줄 구성·길이: 엔진이 쓴 줄만, 지나치게 길지 않게
import { SAFETY_DECISION_NOTICE } from '@/lib/desk/plain/outlook';
import { DIRECTION_WORDS, type EffectDirection } from '@/lib/report/direction';
import { displayNumbersMatch, numericTexts } from '@/lib/report/tokens';
import { forbiddenReasons } from '@/lib/report/validate';
import { PLAIN_LINE_KEYS, type PlainLineKey, type PlainLines } from './types';

export type PlainIssueCode =
  | 'untracked_number'
  | 'missing_number'
  | 'missing_label'
  | 'direction_mismatch'
  | 'forbidden_expression'
  | 'safety_notice_missing'
  | 'missing_line'
  | 'extra_line'
  | 'too_long';

export interface LineIssue<K extends string = string> {
  readonly code: PlainIssueCode;
  readonly line: K | null;
  readonly message: string;
}

export type LineTexts<K extends string> = Readonly<Partial<Record<K, string>>>;

export interface LineReference<K extends string = string> {
  /** 엔진이 만든 줄. 값이 없는 줄은 키를 넣지 않는다 */
  readonly lines: LineTexts<K>;
  /** 숫자로 세지 않는 이름 (설비 이름·코드·사이트 이름·계통 이름) */
  readonly labels: readonly string[];
  /** 효과 부호가 가리키는 방향 (없으면 방향 검사를 건너뛴다) */
  readonly direction: EffectDirection | null;
}

export type PlainIssue = LineIssue<PlainLineKey>;
export type PlainReference = LineReference<PlainLineKey>;

/** 엔진 문장보다 이만큼 넘게 길면 내용을 더한 것으로 본다 */
const MAX_LENGTH_RATIO = 2;
const MAX_EXTRA_CHARS = 60;

/**
 * 쉬운 말 설명에서 더 막는 표현.
 * 엔진 문장·플레이북 원문에 이미 있는 말(보증 조건 위반 여부·운전 정지 여부는 안전책임자가 판단 등)은 걸리지 않게 좁게 적는다.
 */
export const PLAIN_FORBIDDEN: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /원인은[^.]{0,20}(입니다|이다)/, reason: '원인을 단정하는 표현' },
  { pattern: /원인(입니다|이다)/, reason: '원인을 단정하는 표현' },
  { pattern: /(때문|탓)(입니다|이다|이에요)/, reason: '원인을 단정하는 표현' },
  { pattern: /(확실히|틀림없|분명히)/, reason: '근거 없이 단정하는 표현' },
  { pattern: /(즉시|당장|반드시)\s*(운전|가동)(을|를)?\s*(정지|중단)/, reason: '안전 판단을 대신하는 정지 지시' },
  { pattern: /(운전|가동)(을|를)?\s*(즉시\s*)?(정지|중단)(하세요|하십시오|해야\s*합니다|하시기)/, reason: '안전 판단을 대신하는 정지 지시' },
  { pattern: /(법적|법률)\s*(책임|조치|자문|대응|검토)/, reason: '법적 조언' },
  { pattern: /손해\s*배상/, reason: '법적 조언' },
  { pattern: /위약금/, reason: '계약 조언' },
  { pattern: /소송/, reason: '법적 조언' },
];

const plainForbiddenReasons = (text: string): string[] => PLAIN_FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);

const at = <K extends string>(code: PlainIssueCode, line: K, message: string): LineIssue<K> => ({ code, line, message });

/** 엔진 숫자와 짝을 지어 본다. 짝이 없는 쪽이 지어낸 숫자(untracked)·빠뜨린 숫자(missing) */
function numberIssues<K extends string>(line: K, candidate: string, reference: string, labels: readonly string[]): LineIssue<K>[] {
  const engine = numericTexts(reference, labels);
  const shown = numericTexts(candidate, labels);
  const used = engine.map(() => false);
  const untracked = shown.filter((text) => {
    const index = engine.findIndex((value, i) => !used[i] && displayNumbersMatch(text, value));
    if (index < 0) return true;
    used[index] = true;
    return false;
  });
  return [
    ...untracked.map((text) => at('untracked_number', line, `엔진이 내지 않은 숫자 "${text}"이(가) 있습니다`)),
    ...engine.filter((_, i) => !used[i]).map((text) => at('missing_number', line, `엔진 수치 "${text}"이(가) 빠졌습니다`)),
  ];
}

/** 엔진 문장에 없던 반대 방향 단어를 새로 넣었는가 (같은 방향 다른 표현은 허용) */
function directionIssues<K extends string>(line: K, candidate: string, reference: string, direction: EffectDirection | null): LineIssue<K>[] {
  if (direction === null) return [];
  const opposite = DIRECTION_WORDS[direction === 'increase' ? 'decrease' : 'increase'];
  return opposite
    .filter((word) => candidate.includes(word) && !reference.includes(word))
    .map((word) => at('direction_mismatch', line, `효과는 ${direction === 'increase' ? '증가' : '감소'} 방향인데 "${word}" 표현을 넣었습니다`));
}

function lineIssues<K extends string>(line: K, candidate: string, reference: LineReference<K>): LineIssue<K>[] {
  const engineText = reference.lines[line] ?? '';
  const text = candidate.trim();
  if (text === '') return [at('missing_line', line, '문장이 비어 있습니다')];
  if (text.length > engineText.length * MAX_LENGTH_RATIO + MAX_EXTRA_CHARS) return [at('too_long', line, `엔진 문장(${engineText.length}자)보다 지나치게 깁니다(${text.length}자)`)];
  const alreadyForbidden = new Set([...forbiddenReasons(engineText), ...plainForbiddenReasons(engineText)]);
  return [
    ...numberIssues(line, text, engineText, reference.labels),
    ...reference.labels.filter((label) => label !== '' && engineText.includes(label) && !text.includes(label)).map((label) => at('missing_label', line, `이름 "${label}"이(가) 빠졌습니다`)),
    ...directionIssues(line, text, engineText, reference.direction),
    ...[...forbiddenReasons(text), ...plainForbiddenReasons(text)].filter((reason) => !alreadyForbidden.has(reason)).map((reason) => at('forbidden_expression', line, `금지 표현: ${reason}`)),
    ...(engineText.includes(SAFETY_DECISION_NOTICE) && !text.includes(SAFETY_DECISION_NOTICE) ? [at('safety_notice_missing', line, `안전 고정 문구가 빠졌습니다: "${SAFETY_DECISION_NOTICE}"`)] : []),
  ];
}

/** 생성한 줄들이 엔진 문장과 같은 사실을 말하는가. 빈 배열이면 채택할 수 있다 */
export function validateLines<K extends string>(keys: readonly K[], candidate: LineTexts<K>, reference: LineReference<K>): LineIssue<K>[] {
  return keys.flatMap((line): LineIssue<K>[] => {
    const engineText = reference.lines[line];
    const text = candidate[line];
    if (engineText === undefined) return text === undefined || text.trim() === '' ? [] : [at('extra_line', line, '엔진이 만들지 않은 줄을 새로 썼습니다')];
    if (text === undefined) return [at('missing_line', line, '문장이 없습니다')];
    return lineIssues(line, text, reference);
  });
}

/** 발견사항 쉬운 말 4줄 검증 */
export const validatePlainLines = (candidate: PlainLines, reference: PlainReference): PlainIssue[] => validateLines(PLAIN_LINE_KEYS, candidate, reference);
