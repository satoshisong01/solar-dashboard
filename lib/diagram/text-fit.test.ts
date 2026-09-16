import { describe, expect, it } from 'vitest';
import { estimateTextWidth, wrapText } from './text-fit';

describe('estimateTextWidth', () => {
  it('한글은 전각, 라틴 문자는 좁게 센다', () => {
    expect(estimateTextWidth('가나다', 10)).toBeCloseTo(30);
    expect(estimateTextWidth('abc', 10)).toBeCloseTo(16.8);
    expect(estimateTextWidth('', 10)).toBe(0);
  });
});

describe('wrapText', () => {
  it('폭 안에 들어가면 한 줄 그대로', () => {
    expect(wrapText('DI 물탱크', 200, 11.5)).toEqual(['DI 물탱크']);
  });

  it('공백에서만 자른다 (낱말을 쪼개지 않는다)', () => {
    expect(wrapText('폐열회수 열교환기 HX-301', 100, 11.5)).toEqual(['폐열회수 열교환기', 'HX-301']);
  });

  it('폭보다 긴 한 낱말은 그대로 둔다', () => {
    expect(wrapText('가나다라마바사', 20, 11.5)).toEqual(['가나다라마바사']);
  });

  it('줄 수 상한을 넘으면 줄임표를 붙인다', () => {
    expect(wrapText('하나 둘 셋 넷 다섯 여섯', 40, 11.5, 2)).toEqual(['하나 둘', '셋 넷…']);
  });

  it('빈 글자는 줄이 없다', () => {
    expect(wrapText('   ', 100, 11.5)).toEqual([]);
  });
});
