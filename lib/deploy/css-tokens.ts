// 배포된 CSS가 지금 소스의 디자인 토큰과 같은 값인지 비교한다 (scripts/deploy-check.ts).
// 빌드 캐시가 옛 CSS를 그대로 내보낸 사고를 잡는 검사다 — 파일 이름(해시)이 아니라 값을 비교하므로
// 해시가 그대로여도 값이 달라졌으면 걸리고, 해시만 바뀌고 값이 같으면 통과한다. 순수 모듈.

/** '/* ... *​/' 주석 제거 (블록 안의 중괄호가 파싱을 어지럽히지 않게 먼저 지운다) */
export const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKEN_NAME = /^--[a-z0-9-]+$/;
const QUOTED = /("[^"]*"|'[^']*')/;

/** 따옴표 밖만 정리한다: 소문자 · 공백 접기 · 쉼표·괄호 주변 공백 제거 · 3자리 hex를 6자리로 */
function normalizeUnquoted(part: string): string {
  return part
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()])\s*/g, '$1')
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, (_, r: string, g: string, b: string) => `#${r}${r}${g}${g}${b}${b}`);
}

/**
 * 같은 값을 다르게 쓴 것(#ffffff ↔ #fff, 쉼표 뒤 공백)을 하나로 맞춘다.
 * 따옴표 안(글꼴 이름)은 대소문자·공백이 값의 일부라 그대로 두고, 작은따옴표만 큰따옴표로 통일한다.
 */
export function normalizeCssValue(value: string): string {
  return value
    .split(QUOTED)
    .map((part, index) => (index % 2 === 1 ? `"${part.slice(1, -1)}"` : normalizeUnquoted(part)))
    .join('')
    .trim();
}

/** 소스 globals.css의 첫 :root 블록(디자인 토큰) → 토큰 이름 → 정규화한 값. @media print 안의 :root는 뒤에 있어 잡히지 않는다 */
export function rootTokens(sourceCss: string): ReadonlyMap<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(stripCssComments(sourceCss))?.[1] ?? '';
  const tokens = new Map<string, string>();
  for (const declaration of block.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    if (TOKEN_NAME.test(name)) tokens.set(name, normalizeCssValue(declaration.slice(colon + 1)));
  }
  return tokens;
}

/** 배포 CSS 안에서 그 토큰이 선언된 모든 값 (:root 말고 .print-root 등 다른 규칙의 값도 함께 나온다) */
export function servedValues(servedCss: string, token: string): readonly string[] {
  if (!TOKEN_NAME.test(token)) throw new Error(`토큰 이름 형식이 아닙니다: ${token}`);
  return [...stripCssComments(servedCss).matchAll(new RegExp(`${token}\s*:([^;}]*)`, 'g'))].map((match) => normalizeCssValue(match[1] ?? ''));
}

export interface TokenMismatch {
  readonly token: string;
  readonly expected: string;
  /** 배포 CSS에 있던 값들 (비어 있으면 그 토큰이 아예 없다) */
  readonly served: readonly string[];
}

export interface TokenComparison {
  readonly checked: number;
  readonly mismatches: readonly TokenMismatch[];
}

/** 소스 :root 토큰마다 같은 값이 배포 CSS에 있는지 본다 */
export function compareTokens(sourceCss: string, servedCss: string): TokenComparison {
  const tokens = rootTokens(sourceCss);
  const mismatches = [...tokens].flatMap(([token, expected]) => {
    const served = servedValues(servedCss, token);
    return served.includes(expected) ? [] : [{ token, expected, served }];
  });
  return { checked: tokens.size, mismatches };
}

/** 배포된 HTML의 <link rel="stylesheet"> 경로 (중복 제거, 나온 순서) */
export function stylesheetHrefs(html: string): readonly string[] {
  const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].flatMap((tag) => {
    const href = /href="([^"]+)"/.exec(tag[0])?.[1];
    return href === undefined ? [] : [href];
  });
  return [...new Set(hrefs)];
}
