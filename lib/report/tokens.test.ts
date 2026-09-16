import { describe, expect, it } from 'vitest';
import type { NumberToken } from './composer';
import { displayNumbersMatch, formatTokenValue, numericTexts, resolvePath, textTokenIssues, tokenMatchesValue } from './tokens';

const token = (overrides: Partial<NumberToken>): NumberToken => ({ text: '', path: 'x', format: 'number', digits: 1, abs: false, ...overrides });

describe('numericTexts', () => {
  it('날짜·시간·천 단위·부호 수를 하나씩 뽑고, 식별자 안 숫자와 95% CI는 세지 않는다', () => {
    expect(numericTexts('RACK01 기간 2026-09-01 ~ 2026-09-30, 10h 00m → 9h 16m, 1,907.6 mV, −7.4%(95% CI −7.5 ~ +2.3), #12, 0.1~0.2C, 18회')).toEqual(['2026-09-01', '2026-09-30', '10h 00m', '9h 16m', '1,907.6', '−7.4', '−7.5', '+2.3', '0.1', '0.2', '18']);
  });

  it('이름 토큰 글자는 먼저 지운다', () => {
    expect(numericTexts('[배터리 랙 1] 조치 "필터 2개 교체"', ['배터리 랙 1', '필터 2개 교체'])).toEqual([]);
  });
});

describe('tokenMatchesValue', () => {
  it('표시 자릿수 반올림 범위 안이면 같다', () => {
    expect(tokenMatchesValue(token({ text: '−7.4', format: 'signed' }), -7.396)).toBe(true);
    expect(tokenMatchesValue(token({ text: '−7.3', format: 'signed' }), -7.396)).toBe(false);
    expect(tokenMatchesValue(token({ text: '85', format: 'percent', digits: 0 }), 0.85)).toBe(true);
    expect(tokenMatchesValue(token({ text: '7.4', abs: true }), -7.396)).toBe(true);
    expect(tokenMatchesValue(token({ text: '12,030', digits: 0 }), 12030.44)).toBe(true);
    expect(tokenMatchesValue(token({ text: '10h 00m', format: 'duration' }), 10.004)).toBe(true);
    expect(tokenMatchesValue(token({ text: '2027-05-01', format: 'date' }), Date.UTC(2027, 3, 30, 15))).toBe(true);
    expect(tokenMatchesValue(token({ text: 'SIM-A', format: 'label' }), 'SIM-B')).toBe(false);
  });

  it('형식에 맞지 않는 값이면 표시할 수 없다', () => {
    expect(formatTokenValue(null, token({}))).toBeNull();
    expect(formatTokenValue(3, token({ format: 'label' }))).toBeNull();
  });
});

describe('resolvePath·textTokenIssues', () => {
  it('배열 첨자와 점 경로를 읽는다', () => {
    const root = { findings: [{ effect: { value: 1 } }, { effect: { value: 2 } }] };
    expect(resolvePath(root, 'findings[1].effect.value')).toBe(2);
    expect(resolvePath(root, 'findings[5].effect.value')).toBeUndefined();
    expect(resolvePath(root, 'findings.constructor')).toBeUndefined();
  });

  it('같은 숫자가 두 번이면 토큰도 두 개여야 한다', () => {
    const tokens = [token({ text: '3', digits: 0 })];
    expect(textTokenIssues('3건 중 3건', tokens).map((i) => i.code)).toEqual(['untracked_number']);
    expect(textTokenIssues('3건 중 3건', [...tokens, token({ text: '3', digits: 0 })])).toEqual([]);
  });
});

describe('displayNumbersMatch', () => {
  it('자릿수가 적은 쪽의 반올림 폭으로 견준다', () => {
    expect(displayNumbersMatch('6', '6.2')).toBe(true);
    expect(displayNumbersMatch('6.2', '6.2')).toBe(true);
    expect(displayNumbersMatch('7', '6.2')).toBe(false);
    expect(displayNumbersMatch('12,030', '12,030')).toBe(true);
    expect(displayNumbersMatch('−7.4', '-7.43')).toBe(true);
  });

  it('날짜처럼 수로 읽히지 않는 표기는 글자가 같아야 한다', () => {
    expect(displayNumbersMatch('2026-07-30', '2026-07-30')).toBe(true);
    expect(displayNumbersMatch('2026-07-31', '2026-07-30')).toBe(false);
  });
});
