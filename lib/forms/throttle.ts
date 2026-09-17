// 같은 사람이 같은 버튼을 연달아 누르는 것을 막는 최소 간격 (연타 방지).
//
// 프로세스 메모리에만 둔다: 서버가 여러 대면 대마다 따로 세므로 정확한 한도가 아니라 연타 완충이다.
// 정확한 한도가 필요해지면 (예: 하루 호출 수) DB에 기록해야 한다 — 여기서 하려 들지 않는다.
// 서버 액션은 요청마다 새로 불리지만 모듈은 프로세스에 남아 있어 마지막 시각을 기억한다.

const lastAcceptedMs = new Map<string, number>();

/** 기억할 키 수 상한. 넘으면 간격이 지난 기록부터 버린다 (메모리가 끝없이 늘지 않게) */
const MAX_KEYS = 200;

export interface ThrottleVerdict {
  readonly ok: boolean;
  /** 막혔을 때 다시 눌러도 되기까지 남은 초 (올림). 통과했으면 0 */
  readonly retryInSec: number;
}

/**
 * key로 자리를 잡는다. 앞선 통과로부터 intervalMs가 지나지 않았으면 막고 남은 시간을 알린다.
 * 막힌 호출은 마지막 시각을 밀지 않는다 — 계속 눌러도 대기 시간이 늘어나지 않는다.
 */
export function takeSlot(key: string, intervalMs: number, nowMs: number = Date.now()): ThrottleVerdict {
  const last = lastAcceptedMs.get(key);
  if (last !== undefined && nowMs - last < intervalMs) return { ok: false, retryInSec: Math.ceil((intervalMs - (nowMs - last)) / 1000) };
  if (lastAcceptedMs.size >= MAX_KEYS) {
    for (const [stale, at] of lastAcceptedMs) if (nowMs - at >= intervalMs) lastAcceptedMs.delete(stale);
  }
  lastAcceptedMs.set(key, nowMs);
  return { ok: true, retryInSec: 0 };
}
