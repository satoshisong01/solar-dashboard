import { describe, expect, it } from 'vitest';
import { parseSeriesQuery } from './series-query';
import { SERIES_LIMITS, buildSeriesSearch, chooseBucket } from './series-types';

const H = 3_600_000;
const FROM = '2026-09-13T11:00:00.000Z';
const TO = '2026-09-14T11:00:00.000Z';

const parse = (query: Record<string, string>) => parseSeriesQuery(new URLSearchParams(query));

describe('chooseBucket', () => {
  it('48시간 이하는 원시, 넘으면 1시간 롤업', () => {
    expect(chooseBucket(48 * H, 600).source).toBe('raw');
    expect(chooseBucket(48 * H + 1, 600).source).toBe('1h');
  });

  it('원시: 기간 ÷ 최대 점 수 이상인 가장 작은 단계를 고른다', () => {
    expect(chooseBucket(H, 600)).toEqual({ source: 'raw', bucketSeconds: 10 }); // 6초 → 10초
    expect(chooseBucket(24 * H, 600)).toEqual({ source: 'raw', bucketSeconds: 300 }); // 144초 → 5분
    expect(chooseBucket(48 * H, 600)).toEqual({ source: 'raw', bucketSeconds: 300 }); // 288초 → 5분
    expect(chooseBucket(6 * H, 600)).toEqual({ source: 'raw', bucketSeconds: 60 }); // 36초 → 1분
  });

  it('정확히 나누어떨어지면 그 단계를 쓴다', () => {
    expect(chooseBucket(6_000_000, 100)).toEqual({ source: 'raw', bucketSeconds: 60 });
  });

  it('1시간 롤업: 1시간의 배수 단계', () => {
    expect(chooseBucket(7 * 24 * H, 600)).toEqual({ source: '1h', bucketSeconds: 3_600 }); // 1008초 → 1시간
    expect(chooseBucket(30 * 24 * H, 600)).toEqual({ source: '1h', bucketSeconds: 7_200 }); // 4320초 → 2시간
    expect(chooseBucket(365 * 24 * H, 600)).toEqual({ source: '1h', bucketSeconds: 86_400 }); // 52560초 → 1일
  });

  it('가장 큰 단계보다 커지면 1일의 배수로 올린다', () => {
    expect(chooseBucket(366 * 24 * H, 50)).toEqual({ source: '1h', bucketSeconds: 8 * 86_400 }); // 7.32일 → 8일
  });

  it('선택한 버킷 수는 최대 점 수를 넘지 않는다', () => {
    for (const spanH of [1, 5, 24, 47, 72, 24 * 7, 24 * 30, 24 * 90, 24 * 366]) {
      for (const maxPoints of [50, 300, 600, 2_000]) {
        const { bucketSeconds } = chooseBucket(spanH * H, maxPoints);
        expect(Math.ceil((spanH * H) / (bucketSeconds * 1_000))).toBeLessThanOrEqual(maxPoints);
      }
    }
  });
});

describe('parseSeriesQuery', () => {
  it('정상 쿼리: 중복 id 제거, maxPoints 기본값 600', () => {
    expect(parse({ pointIds: '3,1,3', from: FROM, to: TO })).toEqual({
      success: true,
      data: { pointIds: [3, 1], fromMs: Date.parse(FROM), toMs: Date.parse(TO), maxPoints: 600 },
    });
  });

  it('오프셋이 있는 시각과 반복 pointIds 파라미터를 받는다', () => {
    const params = new URLSearchParams([
      ['pointIds', '1'],
      ['pointIds', '2'],
      ['from', '2026-09-13T20:00:00+09:00'],
      ['to', '2026-09-14T20:00:00+09:00'],
      ['maxPoints', '120'],
    ]);
    expect(parseSeriesQuery(params)).toEqual({
      success: true,
      data: { pointIds: [1, 2], fromMs: Date.parse(FROM), toMs: Date.parse(TO), maxPoints: 120 },
    });
  });

  it('pointIds가 없거나 형식이 틀리면 거부한다', () => {
    expect(parse({ from: FROM, to: TO })).toMatchObject({ success: false, error: 'pointIds가 필요합니다' });
    expect(parse({ pointIds: '', from: FROM, to: TO })).toMatchObject({ success: false });
    for (const bad of ['0', '-1', '1.5', 'abc', '1;DROP', '2147483648']) {
      expect(parse({ pointIds: bad, from: FROM, to: TO })).toMatchObject({ success: false });
    }
  });

  it(`pointIds는 최대 ${SERIES_LIMITS.maxPointIds}개`, () => {
    expect(parse({ pointIds: '1,2,3,4,5,6,7,8', from: FROM, to: TO }).success).toBe(true);
    expect(parse({ pointIds: '1,2,3,4,5,6,7,8,9', from: FROM, to: TO })).toMatchObject({
      success: false,
      error: 'pointIds는 최대 8개입니다',
    });
  });

  it('시각 형식·순서·기간을 검사한다', () => {
    expect(parse({ pointIds: '1', from: '2026-09-13', to: TO })).toMatchObject({ success: false });
    expect(parse({ pointIds: '1', from: '2026-09-13T11:00:00', to: TO })).toMatchObject({ success: false }); // 오프셋 없음
    expect(parse({ pointIds: '1', from: TO, to: TO })).toMatchObject({ success: false, error: 'to는 from보다 뒤여야 합니다' });
    expect(parse({ pointIds: '1', from: '2025-01-01T00:00:00Z', to: '2026-09-14T00:00:00Z' })).toMatchObject({
      success: false,
      error: '조회 기간은 366일 이하여야 합니다',
    });
  });

  it('maxPoints 범위를 검사한다', () => {
    expect(parse({ pointIds: '1', from: FROM, to: TO, maxPoints: '49' })).toMatchObject({ success: false });
    expect(parse({ pointIds: '1', from: FROM, to: TO, maxPoints: '2001' })).toMatchObject({ success: false });
    expect(parse({ pointIds: '1', from: FROM, to: TO, maxPoints: '12.5' })).toMatchObject({ success: false });
  });
});

describe('buildSeriesSearch', () => {
  it('parseSeriesQuery와 왕복한다', () => {
    const query = { pointIds: [5, 9], fromMs: Date.parse(FROM), toMs: Date.parse(TO), maxPoints: 600 };
    expect(parseSeriesQuery(new URLSearchParams(buildSeriesSearch(query)))).toEqual({ success: true, data: query });
  });
});
