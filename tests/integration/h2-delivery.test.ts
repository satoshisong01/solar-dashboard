// 외부 수소 반입 기록 저장(직접 입력·CSV)과 원장용 일별 합계 조회. Server Action은 권한 확인 뒤 이 함수들을 부른다.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kstDayStart } from '@/lib/analytics/types';
import { checkDeliveryCsvText, deliveryRowToInput, insertDeliveries, loadDeliveredByDay } from '@/lib/ops/h2-delivery';
import { createTestDb } from '../support/ingest-fixture';

const SITE_CODE = 'IT-SUPPLY';
const DAY1 = Date.parse('2001-03-01T00:00:00+09:00');
const DAY2 = Date.parse('2001-03-02T00:00:00+09:00');
const NOW = Date.parse('2001-03-05T00:00:00+09:00');
const HOUR = 3_600_000;

const HEADER = 'site_code,delivered_at,supplier,vehicle_no,mass_kg,heel_mass_kg,unit_price_krw';

describe('외부 수소 반입 기록 (hysol_test)', () => {
  const db = createTestDb();
  let siteId = 0;

  beforeAll(async () => {
    await cleanup();
    const site = await db.insertInto('om.site').values({ code: SITE_CODE, name: '반입 테스트 사이트' }).returning('id').executeTakeFirstOrThrow();
    siteId = site.id;
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  beforeEach(async () => {
    if (siteId > 0) await db.deleteFrom('om.h2_delivery').where('site_id', '=', siteId).execute();
  });

  async function cleanup(): Promise<void> {
    const site = await db.selectFrom('om.site').select('id').where('code', '=', SITE_CODE).executeTakeFirst();
    if (!site) return;
    await db.deleteFrom('om.h2_delivery').where('site_id', '=', site.id).execute();
    await db.deleteFrom('om.site').where('id', '=', site.id).execute();
  }

  const record = (deliveredAt: number, supplier: string, vehicleNo: string | null, massKg: number) => ({
    siteId,
    assetId: null,
    deliveredAt,
    supplier,
    vehicleNo,
    massKg,
    heelMassKg: null,
    unitPriceKrw: null,
    amountKrw: null,
    purityPct: null,
    note: null,
  });

  it('같은 사이트·일시·공급사·차량번호는 유니크 인덱스가 한 번만 넣는다 (재업로드 안전)', async () => {
    const first = await insertDeliveries(db, [record(DAY1 + 14 * HOUR, '○○가스', '12가3456', 318.4)], { source: 'manual', actor: 'a@example.com' });
    expect(first).toEqual({ inserted: 1, duplicates: 0 });
    const again = await insertDeliveries(db, [record(DAY1 + 14 * HOUR, '○○가스', '12가3456', 318.4)], { source: 'csv', actor: 'a@example.com' });
    expect(again).toEqual({ inserted: 0, duplicates: 1 });
    // 차량번호가 비어 있어도 (COALESCE) 중복 판정이 된다
    await insertDeliveries(db, [record(DAY1 + 15 * HOUR, '○○가스', null, 300)], { source: 'manual', actor: 'a@example.com' });
    expect(await insertDeliveries(db, [record(DAY1 + 15 * HOUR, '○○가스', null, 300)], { source: 'manual', actor: 'a@example.com' })).toEqual({ inserted: 0, duplicates: 1 });
  });

  it('원장용 일별 합계는 하역 시각의 KST 날짜로 묶고, 기록이 없는 날은 키 자체가 없다 (0이 아니다)', async () => {
    await insertDeliveries(
      db,
      [record(DAY1 + 2 * HOUR, 'A가스', '1', 100), record(DAY1 + 23 * HOUR, 'B가스', '2', 200), record(DAY2 + 9 * HOUR, 'A가스', '3', 50)],
      { source: 'manual', actor: 'a@example.com' },
    );
    const byDay = await loadDeliveredByDay(db, siteId, { start: DAY1, end: DAY2 + 24 * HOUR });
    expect(byDay.get(kstDayStart(DAY1))).toBeCloseTo(300, 6);
    expect(byDay.get(kstDayStart(DAY2))).toBeCloseTo(50, 6);
    expect(byDay.has(kstDayStart(DAY2) + 24 * HOUR)).toBe(false);
    // 창 밖 기록은 세지 않는다
    expect([...(await loadDeliveredByDay(db, siteId, { start: DAY2, end: DAY2 + 24 * HOUR })).keys()]).toEqual([kstDayStart(DAY2)]);
  });

  it('CSV 검증은 DB의 사이트·기존 기록과 대조하고, 통과한 행만 저장한다', async () => {
    const good = await checkDeliveryCsvText(db, `${HEADER}\n${SITE_CODE},2001-03-01 14:30,○○가스,12가3456,318.4,42.1,9800`, NOW);
    expect(good.errorCount).toBe(0);
    expect(await insertDeliveries(db, good.rows.map(deliveryRowToInput), { source: 'csv', actor: 'a@example.com' })).toEqual({ inserted: 1, duplicates: 0 });

    // 같은 파일을 다시 올리면 DB 조회 결과로 중복이 잡혀 미리보기 단계에서 막힌다
    const again = await checkDeliveryCsvText(db, `${HEADER}\n${SITE_CODE},2001-03-01 14:30,○○가스,12가3456,318.4,42.1,9800`, NOW);
    expect(again.errorCount).toBe(1);
    expect(again.errors[0]?.message).toContain('이미 등록되어');

    const unknownSite = await checkDeliveryCsvText(db, `${HEADER}\nZZ-999,2001-03-01 14:30,○○가스,,1,,`, NOW);
    expect(unknownSite.errors[0]?.message).toContain('없는 사이트');
  });
});
