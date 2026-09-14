// 수익 요약 위젯 입력(om.market_daily) 항목. 순수 모듈 (서버·클라이언트 공용).
// market_key 목록은 db/migrations의 market_daily CHECK 제약과 같아야 한다.

export const MARKET_KEYS = ['smp_land', 'smp_jeju', 'rec_avg'] as const;
export type MarketKey = (typeof MARKET_KEYS)[number];

export const MARKET_LABELS: Readonly<Record<MarketKey, string>> = {
  smp_land: 'SMP (육지)',
  smp_jeju: 'SMP (제주)',
  rec_avg: 'REC 평균',
};

/** 항목별 저장 단위. REC는 1 REC = 1 MWh 기준 가격 */
export const MARKET_UNITS: Readonly<Record<MarketKey, string>> = {
  smp_land: '원/kWh',
  smp_jeju: '원/kWh',
  rec_avg: '원/REC',
};

/** 오타(자릿수 착오)를 막는 절댓값 상한 */
export const MARKET_VALUE_ABS_MAX = 10_000_000;

export function isMarketKey(value: string): value is MarketKey {
  return (MARKET_KEYS as readonly string[]).includes(value);
}

export interface MarketRow {
  /** YYYY-MM-DD (KST 날짜) */
  readonly day: string;
  readonly marketKey: MarketKey;
  readonly value: number;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** YYYY-MM-DD이고 달력에 있는 날짜(2000~2100년)면 null, 아니면 오류 문구 */
export function dayError(value: string): string | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return '날짜는 YYYY-MM-DD 형식이어야 합니다';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '달력에 없는 날짜입니다';
  }
  if (year < MIN_YEAR || year > MAX_YEAR) return `${MIN_YEAR}~${MAX_YEAR}년 날짜만 입력할 수 있습니다`;
  return null;
}

const NUMBER_PATTERN = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** 천 단위 쉼표 없는 10진수. 범위 밖이거나 숫자가 아니면 오류 문구 */
export function parseMarketValue(raw: string): { readonly value: number } | { readonly error: string } {
  const text = raw.trim();
  if (!NUMBER_PATTERN.test(text)) return { error: '값은 숫자여야 합니다 (천 단위 쉼표 없이)' };
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > MARKET_VALUE_ABS_MAX) {
    return { error: `값은 절댓값 ${MARKET_VALUE_ABS_MAX.toLocaleString('ko-KR')} 이하여야 합니다` };
  }
  return { value };
}
