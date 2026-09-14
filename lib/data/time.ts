// KST 일·월 경계 계산. 순수 모듈 (한국은 일광절약시간이 없어 고정 오프셋으로 계산한다).

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

/** nowMs가 속한 KST 날짜의 00:00(UTC epoch ms)에서 dayOffset일 이동한 시각 */
export function kstDayStartMs(nowMs: number, dayOffset = 0): number {
  const kstMidnight = Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return kstMidnight - KST_OFFSET_MS + dayOffset * DAY_MS;
}

/** nowMs가 속한 KST 달의 1일 00:00 (UTC epoch ms) */
export function kstMonthStartMs(nowMs: number): number {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - KST_OFFSET_MS;
}

export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** 어제(KST 00:00~24:00)와 오늘(KST 00:00~now) */
export function yesterdayAndToday(nowMs: number): Readonly<{ yesterday: TimeWindow; today: TimeWindow }> {
  const todayStart = kstDayStartMs(nowMs);
  return {
    yesterday: { fromMs: kstDayStartMs(nowMs, -1), toMs: todayStart },
    today: { fromMs: todayStart, toMs: nowMs },
  };
}

/**
 * 요청 처리 시각. 서버 컴포넌트는 요청마다 한 번 렌더되므로 여기서 시계를 읽어 하위 계산에 넘긴다
 * (클라이언트 재렌더를 전제로 한 react-hooks/purity 규칙은 Date.now()를 컴포넌트 본문에서 막는다).
 */
export function requestTimeMs(): number {
  return Date.now();
}
