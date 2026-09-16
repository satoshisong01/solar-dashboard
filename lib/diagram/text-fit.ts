// SVG는 글자를 줄바꿈해 주지 않는다. 상자 폭에 맞춰 미리 줄을 나누기 위한 순수 함수 ('server-only' 금지).
// 폭은 글자 종류별 어림값으로 잰다 — 브라우저 실측이 아니므로 정확한 값이 아니라 "넘치지 않을 만큼"의 보수적 추정이다.

/** 한글·한자·가나처럼 전각으로 그려지는 글자 */
const isWide = (ch: string): boolean => /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch);

/** 글자 폭 어림 [px]. 전각 1.0 em, 그 밖 0.56 em (공백은 0.3 em) */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += ch === ' ' ? 0.3 : isWide(ch) ? 1 : 0.56;
  return em * fontSize;
}

/**
 * 폭에 맞춰 줄을 나눈다. 공백에서만 자르고, 한 낱말이 폭보다 길면 그 낱말은 그대로 둔다 (글자를 쪼개지 않는다).
 * maxLines를 넘는 줄은 버리고 마지막 줄 끝에 줄임표를 붙인다.
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, maxLines = 2): readonly string[] {
  const words = text.split(' ').filter((word) => word !== '');
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  return [...kept.slice(0, -1), `${kept[kept.length - 1] as string}…`];
}
