// SMP·REC 일별 값 CSV (헤더 day,market_key,value) 검증. 순수 모듈 (서버·클라이언트 공용).
// 화면 미리보기와 적용 Server Action이 같은 함수를 쓴다. 적용 쪽은 미리보기 결과를 믿지 않고 다시 검증한다.
import { parseCsv } from '@/lib/csv/parse';
import { dayError, isMarketKey, MARKET_KEYS, parseMarketValue, type MarketRow } from './keys';

export const MARKET_CSV_HEADER = ['day', 'market_key', 'value'] as const;
/** 파일 크기 상한 (문자 수). Server Action 본문 기본 상한 1 MB 안에 들어가게 둔다 */
export const MARKET_CSV_MAX_CHARS = 512_000;
export const MARKET_CSV_MAX_ROWS = 5_000;
/** 화면에 보여 줄 오류 수 상한 (전체 개수는 따로 센다) */
const MAX_REPORTED_ERRORS = 50;

export interface CsvRowError {
  /** 파일 줄 번호 (헤더가 1행) */
  readonly line: number;
  readonly message: string;
}

export interface MarketCsvResult {
  readonly rows: readonly MarketRow[];
  /** 앞에서부터 최대 50개 */
  readonly errors: readonly CsvRowError[];
  readonly errorCount: number;
  /** 헤더를 뺀 데이터 행 수 */
  readonly dataRows: number;
}

const failure = (line: number, message: string): MarketCsvResult => ({ rows: [], errors: [{ line, message }], errorCount: 1, dataRows: 0 });

function headerError(fields: readonly string[]): string | null {
  const names = fields.map((field) => field.trim().toLowerCase());
  const matches = names.length === MARKET_CSV_HEADER.length && MARKET_CSV_HEADER.every((name, index) => names[index] === name);
  return matches ? null : `첫 줄은 헤더 ${MARKET_CSV_HEADER.join(',')} 이어야 합니다`;
}

type RowCheck = { readonly row: MarketRow } | { readonly error: string };

function checkRow(fields: readonly string[]): RowCheck {
  if (fields.length !== MARKET_CSV_HEADER.length) return { error: `열이 ${MARKET_CSV_HEADER.length}개여야 합니다 (지금 ${fields.length}개)` };
  const [dayRaw, keyRaw, valueRaw] = fields.map((field) => field.trim());
  const dayProblem = dayError(dayRaw);
  if (dayProblem) return { error: `day: ${dayProblem}` };
  if (!isMarketKey(keyRaw)) return { error: `market_key는 ${MARKET_KEYS.join(', ')} 중 하나여야 합니다` };
  const parsed = parseMarketValue(valueRaw);
  if ('error' in parsed) return { error: `value: ${parsed.error}` };
  return { row: { day: dayRaw, marketKey: keyRaw, value: parsed.value } };
}

/** CSV 텍스트 전체를 검증한다. 오류가 하나라도 있으면 적용하지 않는다 (errorCount > 0) */
export function parseMarketCsv(text: string): MarketCsvResult {
  if (text.length > MARKET_CSV_MAX_CHARS) return failure(1, `파일이 너무 큽니다 (최대 ${MARKET_CSV_MAX_CHARS.toLocaleString('ko-KR')}자)`);
  const parsed = parseCsv(text);
  if (!parsed.ok) return failure(1, parsed.error);

  const [header, ...data] = parsed.records;
  if (!header) return failure(1, '내용이 없습니다');
  const problem = headerError(header.fields);
  if (problem) return failure(header.line, problem);
  if (data.length === 0) return failure(header.line, '헤더 아래에 데이터 행이 없습니다');
  if (data.length > MARKET_CSV_MAX_ROWS) {
    return { ...failure(header.line, `데이터 행은 최대 ${MARKET_CSV_MAX_ROWS.toLocaleString('ko-KR')}개입니다`), dataRows: data.length };
  }

  const firstLineOf = new Map<string, number>();
  const rows: MarketRow[] = [];
  const errors: CsvRowError[] = [];
  for (const record of data) {
    const check = checkRow(record.fields);
    if ('error' in check) {
      errors.push({ line: record.line, message: check.error });
      continue;
    }
    const key = `${check.row.day}|${check.row.marketKey}`;
    const seenAt = firstLineOf.get(key);
    if (seenAt !== undefined) {
      errors.push({ line: record.line, message: `${seenAt}행과 날짜·항목이 겹칩니다` });
      continue;
    }
    firstLineOf.set(key, record.line);
    rows.push(check.row);
  }
  return { rows, errors: errors.slice(0, MAX_REPORTED_ERRORS), errorCount: errors.length, dataRows: data.length };
}
