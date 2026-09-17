// 명판 표시: 설비 종류 스키마의 제목·순서를 쓰고, 값이 없는 항목을 'null'로 쓰지 않는다.
import { describe, expect, it } from 'vitest';
import { toNameplateEntries } from './assets';

const SCHEMA = {
  type: 'object',
  properties: {
    max_bar: { type: 'number', title: '최고 충전 압력 (bar)' },
    usable_kg: { type: 'number', title: '가용 저장량 (kg)' },
    tank_count: { type: 'integer', title: '용기 수' },
  },
};

describe('toNameplateEntries', () => {
  it('값이 없는 항목은 미등록으로 쓴다 (JSON의 null을 그대로 보이지 않는다)', () => {
    const entries = toNameplateEntries({ max_bar: 30, usable_kg: null, tank_count: 1 }, SCHEMA);
    expect(entries).toEqual([
      { key: 'max_bar', title: '최고 충전 압력 (bar)', value: '30' },
      { key: 'usable_kg', title: '가용 저장량 (kg)', value: '미등록' },
      { key: 'tank_count', title: '용기 수', value: '1' },
    ]);
  });

  it('빈 문자열도 미등록으로 쓴다', () => {
    expect(toNameplateEntries({ max_bar: '  ' }, SCHEMA)[0]?.value).toBe('미등록');
  });

  it('스키마 순서를 따르고, 스키마에 없는 키는 뒤에 키 이름으로 붙인다', () => {
    const entries = toNameplateEntries({ tank_count: 2, min_outlet_bar: 2, max_bar: 30 }, SCHEMA);
    expect(entries.map((entry) => entry.key)).toEqual(['max_bar', 'tank_count', 'min_outlet_bar']);
    expect(entries[2]).toEqual({ key: 'min_outlet_bar', title: 'min_outlet_bar', value: '2' });
  });

  it('스키마가 없거나 명판이 없으면 빈 목록', () => {
    expect(toNameplateEntries(null, null)).toEqual([]);
    expect(toNameplateEntries({}, SCHEMA)).toEqual([]);
  });

  it('참·거짓과 중첩 값도 읽을 수 있게 쓴다', () => {
    const entries = toNameplateEntries({ vent_stack: false, cells: [3, 4] }, {});
    expect(entries.map((entry) => entry.value)).toEqual(['false', '[3,4]']);
  });
});
