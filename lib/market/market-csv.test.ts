import { describe, expect, it } from 'vitest';
import { dayError, parseMarketValue } from './keys';
import { MARKET_CSV_MAX_ROWS, parseMarketCsv } from './market-csv';

const HEADER = 'day,market_key,value';

describe('parseMarketCsv', () => {
  it('헤더 아래 행을 검증된 행으로 바꾼다 (공백·대소문자 헤더·따옴표 값 허용)', () => {
    const result = parseMarketCsv(' Day , MARKET_KEY ,Value\r\n2026-09-01,smp_land,142.35\r\n"2026-09-01", smp_jeju ,"98"\n2026-09-02,rec_avg,71500\n');
    expect(result).toEqual({
      rows: [
        { day: '2026-09-01', marketKey: 'smp_land', value: 142.35 },
        { day: '2026-09-01', marketKey: 'smp_jeju', value: 98 },
        { day: '2026-09-02', marketKey: 'rec_avg', value: 71500 },
      ],
      errors: [],
      errorCount: 0,
      dataRows: 3,
    });
  });

  it('행마다 오류를 줄 번호와 함께 모으고, 올바른 행은 따로 돌려준다', () => {
    const csv = [
      HEADER,
      '2026-09-01,smp_land,140', // 2
      '2026-02-30,smp_land,1', // 3 달력에 없음
      '2026-09-01,smp_mainland,1', // 4 키
      '2026-09-02,rec_avg,1,234', // 5 열 수
      '2026-09-03,rec_avg,1e3', // 6 숫자 형식
      '2026-09-01,smp_land,141', // 7 2행과 중복
      '26-09-04,smp_jeju,1', // 8 날짜 형식
    ].join('\n');
    const result = parseMarketCsv(csv);

    expect(result.rows).toEqual([{ day: '2026-09-01', marketKey: 'smp_land', value: 140 }]);
    expect(result.errorCount).toBe(6);
    expect(result.dataRows).toBe(7);
    expect(result.errors).toEqual([
      { line: 3, message: 'day: 달력에 없는 날짜입니다' },
      { line: 4, message: 'market_key는 smp_land, smp_jeju, rec_avg 중 하나여야 합니다' },
      { line: 5, message: '열이 3개여야 합니다 (지금 4개)' },
      { line: 6, message: 'value: 값은 숫자여야 합니다 (천 단위 쉼표 없이)' },
      { line: 7, message: '2행과 날짜·항목이 겹칩니다' },
      { line: 8, message: 'day: 날짜는 YYYY-MM-DD 형식이어야 합니다' },
    ]);
  });

  it('헤더가 다르거나 데이터가 없으면 1건의 오류', () => {
    expect(parseMarketCsv('day,key,value\n2026-09-01,smp_land,1').errors).toEqual([
      { line: 1, message: '첫 줄은 헤더 day,market_key,value 이어야 합니다' },
    ]);
    expect(parseMarketCsv(`${HEADER}\n`).errors).toEqual([{ line: 1, message: '헤더 아래에 데이터 행이 없습니다' }]);
    expect(parseMarketCsv('').errors).toEqual([{ line: 1, message: '내용이 없습니다' }]);
  });

  it('CSV 문법 오류(닫히지 않은 따옴표)를 그대로 알린다', () => {
    const result = parseMarketCsv(`${HEADER}\n2026-09-01,"smp_land,1`);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].message).toBe('2번째 줄: 따옴표가 닫히지 않았습니다');
  });

  it('행 수 상한을 넘으면 적용하지 않는다', () => {
    const rows = Array.from({ length: MARKET_CSV_MAX_ROWS + 1 }, () => '2026-09-01,smp_land,1');
    const result = parseMarketCsv([HEADER, ...rows].join('\n'));
    expect(result.rows).toEqual([]);
    expect(result.errorCount).toBe(1);
    expect(result.dataRows).toBe(MARKET_CSV_MAX_ROWS + 1);
  });

  it('보고하는 오류는 50개까지만, 개수는 전체를 센다', () => {
    const rows = Array.from({ length: 60 }, () => 'bad,smp_land,1');
    const result = parseMarketCsv([HEADER, ...rows].join('\n'));
    expect(result.errors).toHaveLength(50);
    expect(result.errorCount).toBe(60);
  });
});

describe('dayError · parseMarketValue', () => {
  it('윤년과 연도 범위를 확인한다', () => {
    expect(dayError('2028-02-29')).toBeNull();
    expect(dayError('2027-02-29')).toBe('달력에 없는 날짜입니다');
    expect(dayError('1999-12-31')).toBe('2000~2100년 날짜만 입력할 수 있습니다');
  });

  it('소수·음수는 받고 쉼표·지수·빈 값·범위 초과는 거부한다', () => {
    expect(parseMarketValue(' -3.5 ')).toEqual({ value: -3.5 });
    expect(parseMarketValue('.5')).toEqual({ value: 0.5 });
    expect(parseMarketValue('71,500')).toHaveProperty('error');
    expect(parseMarketValue('')).toHaveProperty('error');
    expect(parseMarketValue('10000001')).toEqual({ error: '값은 절댓값 10,000,000 이하여야 합니다' });
  });
});
