// 외부 수소 반입 기록 저장 (직접 입력·CSV 가져오기)과 원장용 일별 합계 조회.
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 관리자 확인은 Server Action이 한다.
import { sql, type Kysely } from 'kysely';
import { kstDayStart } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import { checkDeliveryCsv, deliveryDuplicateKey, readDeliveryCsv, type DeliveryCsvCatalog, type DeliveryCsvResult, type DeliveryCsvRow, type RawDeliveryRow } from '@/lib/h2delivery/delivery-csv';

/** 한 건 저장에 필요한 값 (CSV 행과 직접 입력이 같은 모양을 쓴다) */
export interface DeliveryInput {
  readonly siteId: number;
  readonly assetId: number | null;
  readonly deliveredAt: number;
  readonly supplier: string;
  readonly vehicleNo: string | null;
  readonly massKg: number;
  readonly heelMassKg: number | null;
  readonly unitPriceKrw: number | null;
  readonly amountKrw: number | null;
  readonly purityPct: number | null;
  readonly note: string | null;
}

export interface SaveDeliveryResult {
  readonly inserted: number;
  /** 검증 뒤 같은 건이 먼저 들어와(동시 가져오기 등) 건너뛴 행 수 */
  readonly duplicates: number;
}

const values = (row: DeliveryInput, meta: Readonly<{ source: 'manual' | 'csv'; actor: string }>) => ({
  site_id: row.siteId,
  asset_id: row.assetId,
  delivered_at: new Date(row.deliveredAt),
  supplier: row.supplier,
  vehicle_no: row.vehicleNo,
  mass_kg: row.massKg,
  heel_mass_kg: row.heelMassKg,
  unit_price_krw: row.unitPriceKrw,
  amount_krw: row.amountKrw,
  purity_pct: row.purityPct,
  note: row.note,
  source: meta.source,
  created_by: meta.actor,
});

/**
 * 한 트랜잭션으로 넣는다. 중복은 유니크 인덱스(사이트·일시·공급사·차량번호) + ON CONFLICT DO NOTHING으로
 * 원자적으로 막는다 — 검증과 적용 사이에 같은 건이 들어오면 건너뛰고 duplicates로 센다.
 */
export async function insertDeliveries(db: Kysely<DB>, rows: readonly DeliveryInput[], meta: Readonly<{ source: 'manual' | 'csv'; actor: string }>): Promise<SaveDeliveryResult> {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 };
  const done = await db
    .insertInto('om.h2_delivery')
    .values(rows.map((row) => values(row, meta)))
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .execute();
  return { inserted: done.length, duplicates: rows.length - done.length };
}

/** CSV 행이 가리키는 사이트와, 그 사이트들에 이미 등록된 반입 건만 읽는다 */
export async function loadDeliveryCsvCatalog(db: Kysely<DB>, rows: readonly RawDeliveryRow[]): Promise<DeliveryCsvCatalog> {
  const siteCodes = [...new Set(rows.map((r) => r.siteCode).filter((c) => c !== ''))];
  const sites = siteCodes.length === 0 ? [] : await db.selectFrom('om.site').select(['id', 'code']).where('code', 'in', siteCodes).execute();
  const existing =
    sites.length === 0
      ? []
      : await db
          .selectFrom('om.h2_delivery')
          .select(['site_id', 'delivered_at', 'supplier', 'vehicle_no'])
          .where('site_id', 'in', sites.map((s) => s.id))
          .execute();
  return {
    sites: new Map(sites.map((s) => [s.code, s.id])),
    existing: new Set(existing.map((e) => deliveryDuplicateKey(e.site_id, e.delivered_at.getTime(), e.supplier, e.vehicle_no))),
  };
}

/** CSV 전체 검증 (미리보기·적용 공용) */
export async function checkDeliveryCsvText(db: Kysely<DB>, text: string, nowMs: number): Promise<DeliveryCsvResult> {
  const read = readDeliveryCsv(text);
  return checkDeliveryCsv(text, read.ok ? await loadDeliveryCsvCatalog(db, read.rows) : { sites: new Map(), existing: new Set() }, nowMs);
}

export const deliveryRowToInput = (row: DeliveryCsvRow): DeliveryInput => ({
  siteId: row.siteId,
  assetId: null, // CSV에는 설비 열이 없다 (반입 설비가 사이트에 하나뿐이라는 전제를 만들지 않는다)
  deliveredAt: row.deliveredAt,
  supplier: row.supplier,
  vehicleNo: row.vehicleNo,
  massKg: row.massKg,
  heelMassKg: row.heelMassKg,
  unitPriceKrw: row.unitPriceKrw,
  amountKrw: row.amountKrw,
  purityPct: row.purityPct,
  note: row.note,
});

/**
 * 원장용: KST 날짜 0시(epoch ms) → 그날 반입량 합계 [kg]. 기록이 한 건도 없는 날은 키가 없다(0이 아니다).
 * 날짜 귀속은 하역 완료 시각의 KST 날짜다.
 */
export async function loadDeliveredByDay(db: Kysely<DB>, siteId: number, window: Readonly<{ start: number; end: number }>): Promise<Map<number, number>> {
  const { rows } = await sql<{ day: string; mass_kg: number }>`
    SELECT to_char((delivered_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS day, sum(mass_kg)::float8 AS mass_kg
    FROM om.h2_delivery
    WHERE site_id = ${siteId} AND delivered_at >= ${new Date(window.start).toISOString()}::timestamptz AND delivered_at < ${new Date(window.end).toISOString()}::timestamptz
    GROUP BY 1
  `.execute(db);
  return new Map(rows.map((r) => [kstDayStart(Date.parse(`${r.day}T00:00:00+09:00`)), r.mass_kg]));
}
