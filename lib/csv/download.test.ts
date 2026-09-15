import { describe, expect, it } from 'vitest';
import { asciiFallbackFilename, contentDispositionAttachment, csvDownloadHeaders, encodeRfc5987 } from './download';

describe('CSV 응답 헤더', () => {
  it('한국어 파일명은 RFC 5987 UTF-8 퍼센트 인코딩, ASCII 대체 이름을 함께 둔다', () => {
    const name = '탐지준비도_SIM-B_2026-09-15.csv';
    expect(encodeRfc5987('탐지')).toBe('%ED%83%90%EC%A7%80');
    expect(contentDispositionAttachment(name)).toBe(`attachment; filename="______SIM-B_2026-09-15.csv"; filename*=UTF-8''%ED%83%90%EC%A7%80%EC%A4%80%EB%B9%84%EB%8F%84_SIM-B_2026-09-15.csv`);
    expect(decodeURIComponent(encodeRfc5987(name))).toBe(name);
  });

  it("attr-char 밖 ASCII(공백 ' ( ) * % \" ;)도 인코딩하고, 대체 이름은 따옴표·역슬래시를 바꾼다", () => {
    expect(encodeRfc5987("a b'(c)*%\";.csv")).toBe('a%20b%27%28c%29%2A%25%22%3B.csv');
    expect(asciiFallbackFilename('a"b\\c\nd.csv')).toBe('a_b_c_d.csv');
    expect(asciiFallbackFilename('준비도')).toBe('___');
    expect(asciiFallbackFilename('')).toBe('download.csv');
  });

  it('UTF-8 CSV·첨부·캐시 금지·스니핑 금지', () => {
    expect(csvDownloadHeaders('x.csv')).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="x.csv"; filename*=UTF-8''x.csv`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
});
