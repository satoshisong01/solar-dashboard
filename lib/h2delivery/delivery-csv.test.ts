import { describe, expect, it } from 'vitest';
import { checkDeliveryCsv, deliveryDuplicateKey, readDeliveryCsv, type DeliveryCsvCatalog } from './delivery-csv';

/** 2026-09-10 14:30 KST */
const AT = Date.parse('2026-09-10T14:30:00+09:00');
const NOW = Date.parse('2026-09-16T00:00:00+09:00');
const SITE_ID = 7;

const catalog = (existing: readonly string[] = []): DeliveryCsvCatalog => ({ sites: new Map([['GP-1', SITE_ID]]), existing: new Set(existing) });

const HEADER_5 = 'site_code,delivered_at,supplier,vehicle_no,mass_kg';
const HEADER_ALL = 'site_code,delivered_at,supplier,vehicle_no,mass_kg,heel_mass_kg,unit_price_krw,amount_krw,purity_pct,note';

describe('반입 기록 CSV', () => {
  it('필수 5열만 있어도 읽고, 뒤 5열을 순서대로 더 붙일 수 있다', () => {
    const short = checkDeliveryCsv(`${HEADER_5}\nGP-1,2026-09-10 14:30,○○가스,12가3456,318.4`, catalog(), NOW);
    expect(short.errorCount).toBe(0);
    expect(short.rows[0]).toMatchObject({ siteId: SITE_ID, deliveredAt: AT, supplier: '○○가스', vehicleNo: '12가3456', massKg: 318.4, heelMassKg: null, unitPriceKrw: null, purityPct: null, note: null });

    const full = checkDeliveryCsv(`${HEADER_ALL}\nGP-1,2026-09-10 14:30,○○가스,12가3456,"318.4",42.1,"9,800",3120320,99.97,정기 납품`, catalog(), NOW);
    expect(full.errorCount).toBe(0);
    // 천 단위 쉼표가 든 단가는 따옴표로 감싸 넣어도 숫자로 읽는다 (전표를 그대로 옮겨 적는 경우)
    expect(full.rows[0]).toMatchObject({ massKg: 318.4, heelMassKg: 42.1, unitPriceKrw: 9800, amountKrw: 3_120_320, purityPct: 99.97, note: '정기 납품' });

    const middle = checkDeliveryCsv(`site_code,delivered_at,supplier,vehicle_no,mass_kg,heel_mass_kg,unit_price_krw\nGP-1,2026-09-10,○○가스,,318.4,,9800`, catalog(), NOW);
    expect(middle.errorCount).toBe(0);
    expect(middle.rows[0]).toMatchObject({ vehicleNo: null, heelMassKg: null, unitPriceKrw: 9800 });
  });

  it('헤더가 다르거나 열 수가 헤더와 다르면 거부한다', () => {
    expect(readDeliveryCsv('site_code,supplier,mass_kg\nGP-1,가스,1').ok).toBe(false);
    expect(readDeliveryCsv(`${HEADER_5}`).ok).toBe(false); // 데이터 행 없음
    const widthMismatch = checkDeliveryCsv(`${HEADER_5}\nGP-1,2026-09-10,○○가스,12가3456`, catalog(), NOW);
    expect(widthMismatch.errors[0]?.message).toContain('열이 헤더와 같은 5개여야');
  });

  it('행 오류: 없는 사이트·날짜 형식·미래 시각·반입량·순도 범위', () => {
    const rows = [
      'ZZ-9,2026-09-10,○○가스,,10',
      'GP-1,2026/09/10,○○가스,,10',
      'GP-1,2026-09-20,○○가스,,10',
      'GP-1,2026-09-10,,,10',
      'GP-1,2026-09-10,○○가스,,0',
      'GP-1,2026-09-10,○○가스,,abc',
      'GP-1,2026-09-10,○○가스,,10',
    ].join('\n');
    const result = checkDeliveryCsv(`${HEADER_ALL.split(',').slice(0, 5).join(',')}\n${rows}`, catalog(), NOW);
    expect(result.errorCount).toBe(6);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('없는 사이트'),
      expect.stringContaining('delivered_at: YYYY-MM-DD'),
      expect.stringContaining('미래 시각'),
      expect.stringContaining('공급사를 입력'),
      expect.stringContaining('mass_kg: 0 초과'),
      expect.stringContaining('mass_kg: 숫자'),
    ]);
    expect(result.rows).toHaveLength(1); // 오류가 있으면 화면이 적용을 막는다 (errorCount > 0)
  });

  it('이미 등록된 건과 파일 안 중복을 같은 키(사이트·일시·공급사·차량번호)로 막는다', () => {
    const existing = deliveryDuplicateKey(SITE_ID, AT, '○○가스', '12가3456');
    const dup = checkDeliveryCsv(`${HEADER_5}\nGP-1,2026-09-10 14:30,○○가스,12가3456,318.4`, catalog([existing]), NOW);
    expect(dup.errors[0]?.message).toContain('이미 등록되어');

    const twice = checkDeliveryCsv(`${HEADER_5}\nGP-1,2026-09-10 14:30,○○가스,12가3456,318.4\nGP-1,2026-09-10 14:30,○○가스,12가3456,200`, catalog(), NOW);
    expect(twice.errorCount).toBe(1);
    expect(twice.errors[0]?.message).toContain('겹칩니다');
    // 차량번호가 다르면 같은 시각·공급사라도 별개 건이다 (하루 여러 대가 들어온다)
    const twoTrucks = checkDeliveryCsv(`${HEADER_5}\nGP-1,2026-09-10 14:30,○○가스,12가3456,318.4\nGP-1,2026-09-10 14:30,○○가스,34나5678,300`, catalog(), NOW);
    expect(twoTrucks.errorCount).toBe(0);
    expect(twoTrucks.rows).toHaveLength(2);
  });
});
