// 응답 본문 읽기 (순수). 모델은 줄 키 → 문장 하나짜리 JSON 객체를 돌려준다.
// 쉬운 말 4줄(prompt.ts)과 종합 요약 4줄(digest-prompt.ts)이 같은 규칙으로 읽는다.
import { asRecord, asString } from '@/lib/desk/json-read';
import type { LineTexts } from './validate';

/** ```json 울타리를 두르고 오는 응답도 읽는다 */
const unfence = (text: string): string => text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

/** 응답 본문 → 줄 묶음. JSON이 아니면 null, 문자열이 아닌 값은 버린다 (검증에서 빠진 줄로 잡힌다) */
export function parseLines<K extends string>(keys: readonly K[], text: string): LineTexts<K> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = asString(record[key]);
      return value === null ? [] : [[key, value.trim()]];
    }),
  ) as LineTexts<K>;
}
