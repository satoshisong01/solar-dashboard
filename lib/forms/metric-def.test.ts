import { describe, expect, it } from 'vitest';
import { parseMetricDefForm, splitAliases } from './metric-def';

const VALID = {
  key: 'stack.temp.in',
  nameKo: '스택 입구 온도',
  quantity: 'temperature',
  unit: '°C',
  valueKind: 'gauge',
  rollup: 'avg',
  hardMin: '-40',
  hardMax: '150',
  expectedMin: '5',
  expectedMax: '85',
  flatlineMaxS: '21600',
  aliases: 'TmpIn\nSunSpec 1, TmpIn',
} as const;

const errorsOf = (patch: Readonly<Record<string, string>>) => {
  const result = parseMetricDefForm({ ...VALID, ...patch });
  if (result.ok) throw new Error('검증이 통과하면 안 됩니다');
  return result.fieldErrors;
};

describe('parseMetricDefForm', () => {
  it('숫자 범위·고착 시간·별칭 목록으로 바꾼다', () => {
    expect(parseMetricDefForm(VALID)).toEqual({
      ok: true,
      input: {
        key: 'stack.temp.in',
        nameKo: '스택 입구 온도',
        quantity: 'temperature',
        unit: '°C',
        valueKind: 'gauge',
        rollup: 'avg',
        hardMin: -40,
        hardMax: 150,
        expectedMin: 5,
        expectedMax: 85,
        flatlineMaxS: 21600,
        aliases: ['TmpIn', 'SunSpec 1'],
      },
    });
  });

  it('선택 항목은 비워 둘 수 있다 (무차원 단위 포함)', () => {
    const result = parseMetricDefForm({ ...VALID, unit: '', hardMin: '', hardMax: '', expectedMin: '', expectedMax: '', flatlineMaxS: '', aliases: '' });
    expect(result).toMatchObject({ ok: true, input: { unit: '', hardMin: null, hardMax: null, flatlineMaxS: null, aliases: [] } });
  });

  it.each(['Stack.temp', 'stack', 'stack.', '1stack.temp', 'stack.temp-in', 'stack_temp.in'])('키 규칙 위반: %s', (key) => {
    expect(errorsOf({ key })).toHaveProperty('key');
  });

  it('키 길이 상한 64자', () => {
    expect(errorsOf({ key: `a.${'b'.repeat(63)}` })).toEqual({ key: '키는 64자 이하입니다' });
  });

  it('값 종류·롤업은 정해진 값만', () => {
    expect(errorsOf({ valueKind: 'number', rollup: 'median' })).toEqual({ valueKind: '값 종류를 고르세요', rollup: '롤업 방식을 고르세요' });
  });

  it('물리 범위는 하한 < 상한, 정상 범위는 하한 ≤ 상한', () => {
    expect(errorsOf({ hardMin: '10', hardMax: '10' })).toEqual({ hardMax: '물리 상한은 하한보다 커야 합니다' });
    expect(parseMetricDefForm({ ...VALID, expectedMin: '20', expectedMax: '20' }).ok).toBe(true);
    expect(errorsOf({ expectedMin: '21', expectedMax: '20' })).toEqual({ expectedMax: '정상 상한은 하한보다 작을 수 없습니다' });
  });

  it('이름·물리량 누락, 고착 시간 범위 밖, 별칭 과다를 거부한다', () => {
    expect(errorsOf({ nameKo: '  ' })).toEqual({ nameKo: '이름을 입력하세요' });
    expect(errorsOf({ quantity: 'Temperature' })).toHaveProperty('quantity');
    expect(errorsOf({ flatlineMaxS: '0' })).toHaveProperty('flatlineMaxS');
    expect(errorsOf({ aliases: Array.from({ length: 21 }, (_, i) => `a${i}`).join(',') })).toEqual({ aliases: '별칭은 20개까지입니다' });
  });
});

describe('splitAliases', () => {
  it('줄바꿈·쉼표로 나누고 공백·빈 항목·중복을 없앤다', () => {
    expect(splitAliases(' A ,\r\nB\n\n, A,C ')).toEqual(['A', 'B', 'C']);
  });
});
