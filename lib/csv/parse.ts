// 의존성 없는 작은 CSV 파서 (RFC 4180 규칙). 순수 모듈 (서버·클라이언트 공용).
// - 구분자 쉼표, 레코드 구분 LF 또는 CRLF (따옴표 밖의 CR 단독도 줄바꿈으로 본다)
// - 큰따옴표로 감싼 필드 안에서는 쉼표·줄바꿈을 그대로 두고, ""는 " 한 글자
// - 파일 앞의 UTF-8 BOM은 버린다 (엑셀 "CSV UTF-8" 저장 형식)
// - 완전히 빈 줄은 레코드로 치지 않는다

export interface CsvRecord {
  /** 파일 안 줄 번호(1부터). 따옴표 안 줄바꿈이 있으면 레코드가 시작한 줄 */
  readonly line: number;
  readonly fields: readonly string[];
}

export type CsvParseResult =
  | { readonly ok: true; readonly records: readonly CsvRecord[] }
  | { readonly ok: false; readonly error: string };

const BOM = '﻿';

/** 문자열 전체를 레코드로 나눈다. 따옴표 규칙을 어기면 줄 번호가 담긴 오류를 돌려준다 */
export function parseCsv(input: string): CsvParseResult {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  // 파서 내부 누적 상태는 이 함수 안에서만 바뀐다. 돌려주는 레코드는 새 배열이다.
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false; // 따옴표 안
  let closed = false; // 따옴표 필드를 닫은 직후
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    const done = [...fields, field];
    const blank = done.length === 1 && done[0] === '' && !closed;
    if (!blank) records.push({ line: recordLine, fields: done });
    fields = [];
    field = '';
    closed = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
    } else if (ch === ',') {
      fields = [...fields, field];
      field = '';
      closed = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else if (ch === '"') {
      if (field !== '' || closed) return { ok: false, error: `${line}번째 줄: 따옴표는 필드 맨 앞에서만 열 수 있습니다` };
      quoted = true;
    } else {
      if (closed) return { ok: false, error: `${line}번째 줄: 닫는 따옴표 뒤에는 쉼표나 줄바꿈이 와야 합니다` };
      field += ch;
    }
  }

  if (quoted) return { ok: false, error: `${recordLine}번째 줄: 따옴표가 닫히지 않았습니다` };
  endRecord();
  return { ok: true, records };
}
