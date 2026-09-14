import { describe, expect, it } from 'vitest';
import { parseCsv } from './parse';

const fieldsOf = (text: string) => {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(result.error);
  return result.records.map((record) => record.fields);
};

describe('parseCsv', () => {
  it('쉼표와 LF로 필드·레코드를 나눈다', () => {
    expect(fieldsOf('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('CRLF·CR 줄바꿈과 마지막 줄바꿈 없음을 같게 처리한다', () => {
    expect(fieldsOf('a,b\r\n1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('따옴표 안의 쉼표·줄바꿈은 필드 값이고 ""는 따옴표 한 글자다', () => {
    expect(fieldsOf('name,note\n"A, B","첫 줄\n둘째 ""줄"""\n')).toEqual([
      ['name', 'note'],
      ['A, B', '첫 줄\n둘째 "줄"'],
    ]);
  });

  it('빈 필드와 따옴표로 감싼 빈 필드를 보존한다', () => {
    expect(fieldsOf(',,\n"",x,""')).toEqual([
      ['', '', ''],
      ['', 'x', ''],
    ]);
  });

  it('UTF-8 BOM을 버리고 완전히 빈 줄은 건너뛴다', () => {
    expect(fieldsOf('﻿day,value\n\n2026-09-01,1\n\r\n')).toEqual([
      ['day', 'value'],
      ['2026-09-01', '1'],
    ]);
  });

  it('레코드마다 시작 줄 번호를 붙인다 (빈 줄·따옴표 안 줄바꿈 반영)', () => {
    expect(parseCsv('h\n\n"x\ny"\nz')).toEqual({
      ok: true,
      records: [
        { line: 1, fields: ['h'] },
        { line: 3, fields: ['x\ny'] },
        { line: 5, fields: ['z'] },
      ],
    });
  });

  it('닫히지 않은 따옴표는 시작 줄 번호와 함께 오류', () => {
    expect(parseCsv('a\n"열림,2\n3')).toEqual({ ok: false, error: '2번째 줄: 따옴표가 닫히지 않았습니다' });
  });

  it('필드 중간의 따옴표와 닫는 따옴표 뒤 문자는 오류', () => {
    expect(parseCsv('a"b')).toEqual({ ok: false, error: '1번째 줄: 따옴표는 필드 맨 앞에서만 열 수 있습니다' });
    expect(parseCsv('x\n"a"b')).toEqual({ ok: false, error: '2번째 줄: 닫는 따옴표 뒤에는 쉼표나 줄바꿈이 와야 합니다' });
  });

  it('빈 문자열은 레코드가 없다', () => {
    expect(parseCsv('')).toEqual({ ok: true, records: [] });
  });
});
