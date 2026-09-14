// 시뮬레이터 공용 수치·시간 도우미. 순수 함수만 둔다.

export type TimeInput = Date | string | number;

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
/** 가상 사이트는 모두 Asia/Seoul이다 (UTC+9, 서머타임 없음). */
export const KST_OFFSET_MS = 9 * MS_PER_HOUR;

/** Date·ISO 문자열·epoch ms를 epoch ms로 바꾼다. 해석할 수 없으면 오류. */
export function toEpochMs(value: TimeInput, label: string): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} 시각을 해석할 수 없습니다: ${String(value)}`);
  return ms;
}

/** 'YYYY-MM-DD'(KST 날짜) → 그날 KST 0시의 epoch ms */
export function kstDateToMs(date: string): number {
  return toEpochMs(`${date}T00:00:00+09:00`, date);
}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const lerp = (a: number, b: number, fraction: number): number => a + (b - a) * fraction;

/** 1차 지연: 시정수 tauS로 target에 다가간다 (dt가 커도 안정). */
export function lagToward(current: number, target: number, dtS: number, tauS: number): number {
  return target + (current - target) * Math.exp(-dtS / tauS);
}

export type Table = readonly (readonly [x: number, y: number])[];

/** x 오름차순 표의 선형 보간. 범위 밖은 끝값. */
export function interpolate(table: Table, x: number): number {
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) throw new Error('보간 표가 비어 있습니다');
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  const upper = table.findIndex(([tx]) => tx >= x);
  const [x0, y0] = table[upper - 1] ?? first;
  const [x1, y1] = table[upper] ?? last;
  return lerp(y0, y1, (x - x0) / (x1 - x0));
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded; // -0 제거
}

export const kstDayIndex = (tMs: number): number => Math.floor((tMs + KST_OFFSET_MS) / MS_PER_DAY);

/** 그 시각이 속한 KST 날짜의 0시 [epoch ms] */
export const kstDayStartMs = (tMs: number): number => kstDayIndex(tMs) * MS_PER_DAY - KST_OFFSET_MS;

/** [startMs, endMs) 시각 구간 */
export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export const isInWindow = (window: TimeWindow, tMs: number): boolean => tMs >= window.startMs && tMs < window.endMs;

/** 구간 양끝 rampMs 동안 0→1→0으로 바뀌는 계수 (구간 밖 0). 날씨 편차처럼 계단 없이 넣고 뺄 때 쓴다. */
export function edgeRampFraction(window: TimeWindow, tMs: number, rampMs: number): number {
  if (!isInWindow(window, tMs)) return 0;
  if (rampMs <= 0) return 1;
  return clamp(Math.min(tMs - window.startMs, window.endMs - tMs) / rampMs, 0, 1);
}

/** KST 시각(0 이상 24 미만, 소수 포함) */
export function kstHourOfDay(tMs: number): number {
  const msOfDay = (((tMs + KST_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return msOfDay / MS_PER_HOUR;
}

/** KST 기준 연중 일수(1~366) */
export function kstDayOfYear(tMs: number): number {
  const local = new Date(tMs + KST_OFFSET_MS);
  const startOfYear = Date.UTC(local.getUTCFullYear(), 0, 1);
  return Math.floor((local.getTime() - startOfYear) / MS_PER_DAY) + 1;
}
