import { describe, expect, it } from 'vitest';
import { takeSlot } from './throttle';

// 기억이 모듈에 남으므로 테스트마다 다른 키를 쓴다 (시각은 인자로 넣어 고정한다)
const INTERVAL = 10_000;
const NOW = 1_800_000_000_000;

describe('takeSlot', () => {
  it('처음 누르면 통과한다', () => {
    expect(takeSlot('a', INTERVAL, NOW)).toEqual({ ok: true, retryInSec: 0 });
  });

  it('간격 안에 다시 누르면 막고 남은 초를 알린다', () => {
    takeSlot('b', INTERVAL, NOW);
    expect(takeSlot('b', INTERVAL, NOW + 1)).toEqual({ ok: false, retryInSec: 10 });
    expect(takeSlot('b', INTERVAL, NOW + 6_500)).toEqual({ ok: false, retryInSec: 4 });
  });

  it('막힌 호출은 대기 시간을 늘리지 않는다 (연타해도 같은 때에 풀린다)', () => {
    takeSlot('c', INTERVAL, NOW);
    takeSlot('c', INTERVAL, NOW + 3_000);
    takeSlot('c', INTERVAL, NOW + 9_000);
    expect(takeSlot('c', INTERVAL, NOW + INTERVAL)).toEqual({ ok: true, retryInSec: 0 });
  });

  it('간격이 지나면 다시 통과한다', () => {
    takeSlot('d', INTERVAL, NOW);
    expect(takeSlot('d', INTERVAL, NOW + INTERVAL).ok).toBe(true);
  });

  it('키가 다르면 서로 막지 않는다 (사람·대상별로 따로 센다)', () => {
    takeSlot('e:1', INTERVAL, NOW);
    expect(takeSlot('e:2', INTERVAL, NOW).ok).toBe(true);
  });
});
