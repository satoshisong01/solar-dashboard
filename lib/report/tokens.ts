// 본문 숫자 토큰 (순수): 팩 경로 → 표시 문자열, 본문에서 숫자 뽑기, 팩 값 대조, 편집 시 토큰 보존 검사.
// 규칙: 본문의 숫자·날짜·시간 표기는 모두 토큰이어야 하고(추적되지 않은 숫자 금지), 토큰은 팩 값과 표시 반올림 범위에서 같아야 한다.
import { formatHoursMinutes } from '@/lib/desk/conditions';
import { formatSigned } from '@/lib/desk/effect';
import { formatKstDate, formatNumber } from '@/lib/format';
import type { NumberToken, TokenFormat } from './composer';

/** 숫자로 보지 않는 고정 표기 */
const IGNORED_PHRASES: readonly RegExp[] = [/95% CI/g];

/**
 * 본문 숫자: 날짜(YYYY-MM-DD) · 시간(8h 00m) · 천 단위 쉼표 수 · 일반 수 (부호 +, −, - 허용).
 * 영문자·숫자·밑줄·점·#·/ 바로 뒤에 붙은 숫자(RACK01, #12, v1.2)는 식별자로 보고 세지 않는다.
 */
const NUMERIC_PATTERN = /(?<![A-Za-z0-9_.#/])(?:\d{4}-\d{2}-\d{2}|\d+h \d{2}m|[+−-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+−-]?\d+(?:\.\d+)?)(?!\d)/g;

/** 'findings[2].effect.value' 경로로 값을 읽는다. 없으면 undefined */
export function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split('.').flatMap((part) => part.split(/\[(\d+)\]/).filter((s) => s !== ''));
  return segments.reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return /^\d+$/.test(key) ? node[Number(key)] : undefined;
    return Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
  }, root);
}

export interface TokenSpec {
  readonly format: TokenFormat;
  readonly digits: number;
  readonly abs: boolean;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 팩 값 → 표시 문자열. 형식에 맞지 않는 값이면 null */
export function formatTokenValue(value: unknown, spec: TokenSpec): string | null {
  if (spec.format === 'label') return typeof value === 'string' && value !== '' ? value : null;
  if (!finite(value)) return null;
  const v = spec.abs ? Math.abs(value) : value;
  switch (spec.format) {
    case 'number':
      return formatNumber(v, spec.digits);
    case 'signed':
      return formatSigned(v, spec.digits);
    case 'percent':
      return formatNumber(v * 100, spec.digits);
    case 'date':
      return formatKstDate(v);
    case 'duration':
      return formatHoursMinutes(v);
  }
}

/** 문장 조각: 글자와 그 안에 든 토큰 */
export interface Piece {
  readonly text: string;
  readonly tokens: readonly NumberToken[];
}

export function tokenPiece(root: unknown, path: string, spec: TokenSpec): Piece {
  const text = formatTokenValue(resolvePath(root, path), spec);
  if (text === null) throw new Error(`토큰 값을 표시할 수 없습니다: ${path}`);
  return { text, tokens: [{ text, path, ...spec }] };
}

/** 조각·문자열을 이어 붙인다 */
export function seq(...parts: readonly (Piece | string)[]): Piece {
  return parts.reduce<Piece>((acc, part) => (typeof part === 'string' ? { text: acc.text + part, tokens: acc.tokens } : { text: acc.text + part.text, tokens: [...acc.tokens, ...part.tokens] }), { text: '', tokens: [] });
}

export function joinPieces(pieces: readonly Piece[], separator: string): Piece {
  return pieces.reduce<Piece>((acc, piece, index) => seq(acc, index === 0 ? '' : separator, piece), { text: '', tokens: [] });
}

/** 본문에서 숫자 표기를 뽑는다. 고정 표기(95% CI)를 지운 뒤 이름 토큰(label) 글자를 긴 것부터 한 번씩 지운다 */
export function numericTexts(text: string, labels: readonly string[] = []): string[] {
  const withoutFixed = IGNORED_PHRASES.reduce((rest, pattern) => rest.replace(pattern, ' '), text);
  const cleaned = [...labels].sort((a, b) => b.length - a.length).reduce((rest, label) => (label === '' ? rest : rest.replace(label, ' ')), withoutFixed);
  return [...cleaned.matchAll(NUMERIC_PATTERN)].map((match) => match[0]);
}

const countOf = (items: readonly string[]): Map<string, number> => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map<string, number>());

/** a에 있고 b에 모자란 항목 (중복 수 반영) */
function missingFrom(a: readonly string[], b: readonly string[]): string[] {
  const counts = countOf(b);
  return a.filter((item) => {
    const left = counts.get(item) ?? 0;
    if (left === 0) return true;
    counts.set(item, left - 1);
    return false;
  });
}

const parseDisplayedNumber = (text: string): number => Number(text.replace(/,/g, '').replace('−', '-'));
const decimalsOf = (text: string): number => (text.split('.')[1] ?? '').length;

/** 토큰 글자가 팩 값과 표시 반올림 범위에서 같은가 */
export function tokenMatchesValue(token: NumberToken, value: unknown): boolean {
  const expected = formatTokenValue(value, token);
  if (expected === null) return false;
  if (token.text === expected) return true;
  if (token.format === 'label' || token.format === 'date') return false;
  if (token.format === 'duration') {
    const match = /^(\d+)h (\d{2})m$/.exec(token.text);
    return match !== null && finite(value) && Math.abs(Number(match[1]) + Number(match[2]) / 60 - value) <= 0.5 / 60 + 1e-9;
  }
  if (!finite(value)) return false;
  const shown = parseDisplayedNumber(token.text);
  const base = token.abs ? Math.abs(value) : value;
  const actual = token.format === 'percent' ? base * 100 : base;
  // 표시한 자릿수에서 반올림하면 같아지는 범위 (7.4 ↔ 7.396)
  return Number.isFinite(shown) && Math.abs(shown - actual) <= 0.5 * 10 ** -decimalsOf(token.text) + 1e-9;
}

/**
 * 표시 문자열 두 개가 같은 값을 가리키는가 (표시 반올림 허용: '7.4' ↔ '7.396', '6' ↔ '6.2').
 * 자릿수가 적은 쪽의 반올림 폭으로 견준다. 날짜처럼 수로 읽히지 않는 표기는 글자가 같아야 한다.
 * 엔진이 쓴 표기를 문장 생성기(lib/llm)가 자릿수만 줄여 다시 쓴 경우를 같다고 보려고 쓴다.
 */
export function displayNumbersMatch(shown: string, engine: string): boolean {
  if (shown === engine) return true;
  const a = parseDisplayedNumber(shown);
  const b = parseDisplayedNumber(engine);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const digits = Math.min(decimalsOf(shown), decimalsOf(engine));
  return Math.abs(a - b) <= 0.5 * 10 ** -digits + 1e-9;
}

export type TokenIssueCode = 'token_path' | 'token_value' | 'untracked_number' | 'missing_number' | 'missing_label';

export interface TokenIssue {
  readonly code: TokenIssueCode;
  readonly message: string;
}

/** 본문 숫자 = 토큰(중복 수까지), 이름 토큰은 본문에 있어야 한다 */
export function textTokenIssues(text: string, tokens: readonly NumberToken[]): TokenIssue[] {
  const labels = tokens.filter((t) => t.format === 'label').map((t) => t.text);
  const expected = tokens.filter((t) => t.format !== 'label').map((t) => t.text);
  const found = numericTexts(text, labels);
  return [
    ...missingFrom(found, expected).map((n): TokenIssue => ({ code: 'untracked_number', message: `근거와 연결되지 않은 숫자 "${n}"이(가) 있습니다` })),
    ...missingFrom(expected, found).map((n): TokenIssue => ({ code: 'missing_number', message: `근거 수치 "${n}"이(가) 본문에 없습니다` })),
    ...missingFrom(labels, labels.filter((label) => text.includes(label))).map((l): TokenIssue => ({ code: 'missing_label', message: `이름 "${l}"이(가) 본문에 없습니다` })),
  ];
}

/** 블록 토큰을 팩과 대조하고 본문 숫자와 맞춘다 */
export function blockTokenIssues(block: { readonly text: string; readonly numberTokens: readonly NumberToken[] }, pack: unknown): TokenIssue[] {
  const valueIssues = block.numberTokens.flatMap((token): TokenIssue[] => {
    const value = resolvePath(pack, token.path);
    if (value === undefined || formatTokenValue(value, token) === null) return [{ code: 'token_path', message: `근거 경로 ${token.path}에 표시할 값이 없습니다` }];
    return tokenMatchesValue(token, value) ? [] : [{ code: 'token_value', message: `"${token.text}"이(가) 근거 값(${formatTokenValue(value, token)})과 다릅니다` }];
  });
  return [...valueIssues, ...textTokenIssues(block.text, block.numberTokens)];
}
