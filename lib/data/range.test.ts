import { describe, expect, it } from 'vitest';
import { toKstInputValue } from '@/lib/format';
import { buildViewSearch, decodeRouteParam, firstParam, fromKstInputValue, parsePointIds, parsePositiveIntParam, resolveRange } from './range';

const NOW = Date.parse('2026-09-14T11:34:27.500Z');
const NOW_MINUTE = Date.parse('2026-09-14T11:34:00.000Z');
const H = 3_600_000;

describe('resolveRange', () => {
  it('프리셋: 끝은 분 단위 내림, 시작은 기간만큼 앞', () => {
    expect(resolveRange({ range: '7d' }, NOW)).toEqual({
      selection: { kind: 'preset', preset: '7d' },
      fromMs: NOW_MINUTE - 7 * 24 * H,
      toMs: NOW_MINUTE,
    });
  });

  it('없거나 모르는 값은 24시간', () => {
    expect(resolveRange({}, NOW).selection).toEqual({ kind: 'preset', preset: '24h' });
    expect(resolveRange({ range: '1y' }, NOW).selection).toEqual({ kind: 'preset', preset: '24h' });
    expect(resolveRange({ range: 'toString' }, NOW).selection).toEqual({ kind: 'preset', preset: '24h' });
  });

  it('사용자 지정: 올바른 ISO 구간이면 그대로 쓴다', () => {
    const from = '2026-09-01T00:00:00+09:00';
    const to = '2026-09-03T12:00:00.000Z';
    expect(resolveRange({ range: 'custom', from, to }, NOW)).toEqual({
      selection: { kind: 'custom', fromMs: Date.parse(from), toMs: Date.parse(to) },
      fromMs: Date.parse(from),
      toMs: Date.parse(to),
    });
  });

  it('사용자 지정이 틀리면(형식·순서·366일 초과) 24시간으로 되돌린다', () => {
    const fallback = { kind: 'preset', preset: '24h' };
    expect(resolveRange({ range: 'custom', from: 'yesterday', to: '2026-09-03T00:00:00Z' }, NOW).selection).toEqual(fallback);
    expect(resolveRange({ range: 'custom', from: '2026-09-03T00:00:00Z', to: '2026-09-01T00:00:00Z' }, NOW).selection).toEqual(fallback);
    expect(resolveRange({ range: 'custom', from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, NOW).selection).toEqual(fallback);
    expect(resolveRange({ range: 'custom', from: '2026-09-01T00:00:00', to: '2026-09-02T00:00:00Z' }, NOW).selection).toEqual(fallback);
  });
});

describe('parsePointIds', () => {
  const allowed = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it('허용된 id만 입력 순서대로, 중복 없이', () => {
    expect(parsePointIds('3,1,99,3, 2', allowed)).toEqual([3, 1, 2]);
  });

  it('형식이 틀린 조각은 버리고 최대 개수에서 자른다', () => {
    expect(parsePointIds('1,x,-2,0,1.5,4', allowed)).toEqual([1, 4]);
    expect(parsePointIds('1,2,3,4,5,6,7,8,9,10', allowed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsePointIds(undefined, allowed)).toEqual([]);
  });
});

describe('buildViewSearch', () => {
  it('프리셋과 사용자 지정 구간을 URL 쿼리로 만들고 resolveRange와 왕복한다', () => {
    expect(buildViewSearch([4, 2], { kind: 'preset', preset: '30d' })).toBe('points=4%2C2&range=30d');

    const selection = { kind: 'custom', fromMs: Date.parse('2026-09-01T00:00:00Z'), toMs: Date.parse('2026-09-02T00:00:00Z') } as const;
    const params = new URLSearchParams(buildViewSearch([], selection));
    expect(params.get('points')).toBe(''); // 선택 없음도 URL에 남긴다
    const resolved = resolveRange({ range: params.get('range') ?? undefined, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined }, NOW);
    expect(resolved.selection).toEqual(selection);
  });
});

describe('KST datetime-local 변환', () => {
  it('입력값 ↔ epoch ms 왕복', () => {
    const ms = Date.parse('2026-09-14T11:05:00Z');
    expect(toKstInputValue(ms)).toBe('2026-09-14T20:05');
    expect(fromKstInputValue('2026-09-14T20:05')).toBe(ms);
  });

  it('형식이 틀리면 null', () => {
    expect(fromKstInputValue('2026-09-14 20:05')).toBeNull();
    expect(fromKstInputValue('')).toBeNull();
  });
});

describe('firstParam', () => {
  it('배열이면 첫 값', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('x')).toBe('x');
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe('경로 조각', () => {
  it('decodeRouteParam: 잘못된 인코딩이면 null', () => {
    expect(decodeRouteParam('SIM-A')).toBe('SIM-A');
    expect(decodeRouteParam('SIM%2DA')).toBe('SIM-A');
    expect(decodeRouteParam('%E0%A4%A')).toBeNull();
  });

  it('parsePositiveIntParam: int4 범위의 양의 정수만', () => {
    expect(parsePositiveIntParam('42')).toBe(42);
    expect(parsePositiveIntParam('2147483647')).toBe(2_147_483_647);
    for (const bad of ['0', '-1', '1.0', '01', 'abc', '2147483648', '']) expect(parsePositiveIntParam(bad)).toBeNull();
  });
});
