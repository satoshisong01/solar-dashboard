// 지도 키 정규화: 빈 값도 '키 없음'으로 봐야 오류 화면 대신 안내가 나온다.
import { describe, expect, it } from 'vitest';
import { mapKeyOf } from './map-key';

describe('지도 키', () => {
  it('없거나 비었거나 공백뿐이면 키 없음', () => {
    expect(mapKeyOf(undefined)).toBeNull();
    expect(mapKeyOf('')).toBeNull();
    expect(mapKeyOf('   ')).toBeNull();
  });

  it('값이 있으면 앞뒤 공백을 떼고 그대로 쓴다', () => {
    expect(mapKeyOf('abc123')).toBe('abc123');
    expect(mapKeyOf(' abc123 ')).toBe('abc123');
  });
});
