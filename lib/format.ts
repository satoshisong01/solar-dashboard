// 화면 표시용 포맷. 서버·클라이언트 공용 순수 모듈 ('server-only' 금지).
// 시각은 항상 KST로 표시한다 (설계 §5.2: DB는 UTC, 화면은 KST).

export const DISPLAY_TIME_ZONE = 'Asia/Seoul';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const dateTimeParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

type PartName = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

function kstParts(ms: number): Readonly<Record<PartName, string>> {
  const parts = dateTimeParts.formatToParts(new Date(ms));
  const pick = (type: PartName) => parts.find((part) => part.type === type)?.value ?? '00';
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute'), second: pick('second') };
}

/** 2026-09-14 20:05 */
export function formatKstDateTime(ms: number): string {
  const p = kstParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 2026-09-14 20:05:09 */
export function formatKstDateTimeSeconds(ms: number): string {
  const p = kstParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 2026-09-14 */
export function formatKstDate(ms: number): string {
  const p = kstParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** datetime-local 입력값 (KST): 2026-09-14T20:05 */
export function toKstInputValue(ms: number): string {
  const p = kstParts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const numberFormats = new Map<number, Intl.NumberFormat>();

/** 천 단위 구분, 소수 자릿수 상한. null이면 '—' */
export function formatNumber(value: number | null, maxFractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  let format = numberFormats.get(maxFractionDigits);
  if (!format) {
    format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: maxFractionDigits });
    numberFormats.set(maxFractionDigits, format);
  }
  return format.format(value);
}

/** 42분 · 3시간 10분 · 2일 5시간. 1분 미만은 '1분 미만' */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE_MS) return '1분 미만';
  if (safe < HOUR_MS) return `${Math.floor(safe / MINUTE_MS)}분`;
  if (safe < DAY_MS) {
    const hours = Math.floor(safe / HOUR_MS);
    const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
}

/** 기준 시각 대비 경과: '42분 전'. 미래 시각(시계 오차)은 '방금' */
export function formatAgo(ms: number, nowMs: number): string {
  if (ms >= nowMs) return '방금';
  return `${formatDuration(nowMs - ms)} 전`;
}
