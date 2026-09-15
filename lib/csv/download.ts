// CSV 내려받기 응답 헤더 (순수). Content-Disposition 파일명은 RFC 6266 + RFC 5987:
//   filename="…"   ASCII 대체 이름 (ASCII 밖 문자·따옴표·역슬래시·제어문자 → '_')
//   filename*=UTF-8''…  UTF-8 퍼센트 인코딩. RFC 5987 attr-char 밖 문자는 모두 %XX (encodeURIComponent가 남기는 ' ( ) * 도 인코딩)

const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/** RFC 5987 ext-value 값 부분 (UTF-8 퍼센트 인코딩) */
export function encodeRfc5987(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => (byte < 0x80 && ATTR_CHAR.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
}

/** 따옴표 안에 넣을 ASCII 대체 파일명 */
export function asciiFallbackFilename(value: string): string {
  const replaced = [...value].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== '"' && ch !== '\\' ? ch : '_')).join('');
  return replaced.trim() === '' ? 'download.csv' : replaced;
}

export function contentDispositionAttachment(filename: string): string {
  return `attachment; filename="${asciiFallbackFilename(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** CSV 파일 응답 헤더: UTF-8 CSV, 첨부, 캐시 금지, MIME 스니핑 금지 */
export function csvDownloadHeaders(filename: string): Readonly<Record<string, string>> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': contentDispositionAttachment(filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
