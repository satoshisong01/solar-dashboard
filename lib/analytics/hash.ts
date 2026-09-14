// 입력 해시 (finding.input_hash, finding_evidence.input_hash). 같은 입력 → 같은 해시로 재현 여부를 확인한다.
// 보안 용도가 아니다. 순수 TS로 두어 서버·클라이언트·시뮬레이터 메모리 모드 어디서나 같은 값을 낸다.

/** 키를 정렬한 JSON. undefined 속성은 빼고, NaN·Infinity는 문자열로 적는다 (JSON.stringify는 null로 뭉갠다). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `"${String(value)}"`;
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  throw new TypeError(`stableStringify: 직렬화할 수 없는 값 (${typeof value})`);
}

/** 32비트 해시 두 줄 (cyrb53 계열 혼합) → 16진 16자 */
function hash64(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** 입력 값의 안정 해시 (16진 32자) */
export function hashInput(value: unknown): string {
  const text = stableStringify(value);
  return hash64(text, 0) + hash64(text, 0x9e3779b9);
}
