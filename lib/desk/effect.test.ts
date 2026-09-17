// 효과 표기: 데이터 품질 완결성이 수준이 아니라 변화량으로 읽히는지 (옛 발견사항 포함).
import { describe, expect, it } from 'vitest';
import { formatEffectValue, parseEffect } from './effect';

describe('parseEffect: 데이터 품질 완결성', () => {
  const legacy = { metric: 'dq.completeness', value: 91.67, unit: '%', ciLow: null, ciHigh: null, baseline: 100, current: 91.67, levelUnit: '%' };

  it('효과 자리에 수준을 넣어 둔 옛 발견사항은 기준 대비 변화량으로 읽는다', () => {
    const effect = parseEffect(legacy);
    expect(effect.value).toBeCloseTo(-8.33, 2);
    expect(effect.unit).toBe('%p');
    expect(effect.current).toBe(91.67);
    expect(formatEffectValue(effect, 2)).toBe('−8.33%p');
  });

  it('완결성 100%(결측 없음)는 변화량 0이다', () => {
    expect(parseEffect({ ...legacy, value: 100, current: 100 }).value).toBe(0);
  });

  it('이미 변화량으로 저장된 발견사항은 그대로 둔다', () => {
    const effect = parseEffect({ ...legacy, value: -8.33, unit: '%p' });
    expect(effect.value).toBe(-8.33);
    expect(effect.unit).toBe('%p');
  });

  it('다른 지표의 %는 건드리지 않는다', () => {
    expect(parseEffect({ metric: 'capacity_fade_pct', value: -7.3, unit: '%', baseline: 100 })).toMatchObject({ value: -7.3, unit: '%' });
  });
});
