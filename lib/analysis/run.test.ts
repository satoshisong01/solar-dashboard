// 사이트 순서 회전: 시간 예산을 넘겼을 때 늘 같은 사이트만 굶지 않게 한다.
import { describe, expect, it } from 'vitest';
import { CONSOLE_TIME_BUDGET_MS, rotateSites } from './run';

/** 운영 실측(2026-09-17 실행 #7·#8): 30일·사이트 하나가 79~95초 */
const SLOWEST_SITE_MS = 95_000;
/** app/(console)/desk/page.tsx의 maxDuration */
const PAGE_MAX_DURATION_MS = 300_000;

describe('rotateSites', () => {
  const sites = ['SIM-A', 'SIM-B', 'SIM-C', 'GP-1', 'SIM-D'];

  it('실행 id만큼 앞을 잘라 뒤로 보낸다', () => {
    expect(rotateSites(sites, '7')).toEqual(['SIM-C', 'GP-1', 'SIM-D', 'SIM-A', 'SIM-B']);
    expect(rotateSites(sites, '8')).toEqual(['GP-1', 'SIM-D', 'SIM-A', 'SIM-B', 'SIM-C']);
    expect(rotateSites(sites, '10')).toEqual(sites);
  });

  it('사이트를 빠뜨리거나 더하지 않는다', () => {
    for (let id = 0; id < 12; id += 1) expect([...rotateSites(sites, String(id))].sort()).toEqual([...sites].sort());
  });

  it('앞 두 자리만 도는 실행에서도 모든 사이트가 언젠가 먼저 온다', () => {
    const firstTwo = new Set(Array.from({ length: 10 }, (_, id) => rotateSites(sites, String(id + 1)).slice(0, 2)).flat());
    expect([...firstTwo].sort()).toEqual([...sites].sort());
  });

  it('사이트가 하나거나 id가 숫자가 아니면 그대로 둔다', () => {
    expect(rotateSites(['GP-1'], '3')).toEqual(['GP-1']);
    expect(rotateSites(sites, 'abc')).toEqual(sites);
    expect(rotateSites([], '3')).toEqual([]);
  });

  it('아주 큰 실행 id도 나머지로 접는다 (bigint)', () => {
    expect(rotateSites(sites, '9007199254740993')).toEqual(rotateSites(sites, '3'));
  });
});

describe('CONSOLE_TIME_BUDGET_MS', () => {
  it('예산 + 가장 느린 사이트 하나가 페이지 maxDuration 안에 들어온다', () => {
    // 예산은 사이트 하나를 시작할지 정하는 선이라 실제 실행은 '예산 + 사이트 하나'까지 늘어난다
    expect(CONSOLE_TIME_BUDGET_MS + SLOWEST_SITE_MS).toBeLessThan(PAGE_MAX_DURATION_MS);
  });
});
