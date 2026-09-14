import { describe, expect, it } from 'vitest';
import { hashInput, stableStringify } from './hash';
import { kstDateString, kstDayStart } from './types';

describe('stableStringify', () => {
  it('키 순서와 무관하고 undefined 속성은 뺀다', () => {
    expect(stableStringify({ b: 1, a: [1, 'x', null], c: undefined })).toBe('{"a":[1,"x",null],"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('NaN·Infinity를 구분하고 배열 안 undefined는 null', () => {
    expect(stableStringify([Number.NaN, Infinity, undefined, true])).toBe('["NaN","Infinity",null,true]');
    expect(() => stableStringify({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('hashInput', () => {
  it('같은 입력은 같은 32자 해시, 값이 조금만 달라도 다른 해시', () => {
    const a = hashInput({ detector: 'ess.capacity_fade@1', params: { minPerBin: 5 }, values: [400, 375] });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashInput({ values: [400, 375], params: { minPerBin: 5 }, detector: 'ess.capacity_fade@1' })).toBe(a);
    expect(hashInput({ detector: 'ess.capacity_fade@1', params: { minPerBin: 5 }, values: [400, 375.0001] })).not.toBe(a);
  });
});

describe('KST 날짜 도우미', () => {
  it('UTC 15시 이후는 다음 KST 날짜', () => {
    const utc = Date.UTC(2026, 8, 14, 15, 30);
    expect(kstDateString(utc)).toBe('2026-09-15');
    expect(kstDayStart(utc)).toBe(Date.UTC(2026, 8, 14, 15));
    expect(kstDateString(Date.UTC(2026, 8, 14, 14, 59))).toBe('2026-09-14');
  });
});
