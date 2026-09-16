import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';

export const DELIVERY_LIST_LIMIT = 100;

export interface DeliveryFormSite {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  /** 반입 설비(h2.delivery)가 등록된 사이트인가 — 원장이 반입량을 요구하는 사이트다 */
  readonly hasDeliveryAsset: boolean;
}

export interface DeliveryListRow {
  readonly id: string;
  readonly siteCode: string;
  readonly deliveredAtMs: number;
  readonly supplier: string;
  readonly vehicleNo: string | null;
  readonly massKg: number;
  readonly heelMassKg: number | null;
  readonly unitPriceKrw: number | null;
  readonly amountKrw: number | null;
  readonly purityPct: number | null;
  readonly note: string | null;
  readonly source: string;
  readonly createdBy: string;
}

/** 반입 기록을 넣을 수 있는 사이트 (코드순). 반입 설비 유무를 함께 읽어 화면에 표시한다 */
export async function listDeliverySites(): Promise<readonly DeliveryFormSite[]> {
  const rows = await db
    .selectFrom('om.site as s')
    .select((eb) => [
      's.id',
      's.code',
      's.name',
      eb
        .exists(eb.selectFrom('om.asset as a').select('a.id').whereRef('a.site_id', '=', 's.id').where('a.class_key', '=', 'h2.delivery'))
        .as('has_delivery'),
    ])
    .orderBy('s.code')
    .execute();
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, hasDeliveryAsset: r.has_delivery === true }));
}

/** 최근 하역 일시부터 반입 기록. siteCode가 있으면 그 사이트만 */
export async function listDeliveries(siteCode: string | null, limit = DELIVERY_LIST_LIMIT): Promise<{ readonly rows: readonly DeliveryListRow[]; readonly truncated: boolean }> {
  let query = db
    .selectFrom('om.h2_delivery as d')
    .innerJoin('om.site as s', 's.id', 'd.site_id')
    .select(['d.id', 's.code', 'd.delivered_at', 'd.supplier', 'd.vehicle_no', 'd.mass_kg', 'd.heel_mass_kg', 'd.unit_price_krw', 'd.amount_krw', 'd.purity_pct', 'd.note', 'd.source', 'd.created_by'])
    .orderBy('d.delivered_at', 'desc')
    .orderBy('d.id', 'desc')
    .limit(limit + 1);
  if (siteCode !== null) query = query.where('s.code', '=', siteCode);
  const rows = await query.execute();
  return {
    rows: rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      siteCode: r.code,
      deliveredAtMs: r.delivered_at.getTime(),
      supplier: r.supplier,
      vehicleNo: r.vehicle_no,
      massKg: r.mass_kg,
      heelMassKg: r.heel_mass_kg,
      unitPriceKrw: r.unit_price_krw,
      amountKrw: r.amount_krw,
      purityPct: r.purity_pct,
      note: r.note,
      source: r.source,
      createdBy: r.created_by,
    })),
    truncated: rows.length > limit,
  };
}

export interface DeliverySiteSummary {
  readonly siteCode: string;
  readonly days: number;
  readonly totalKg: number;
  readonly lastDeliveredAtMs: number;
}

/** 사이트별 최근 30일 반입 합계 (원장 delivered 항이 실제로 채워지는지 보는 요약) */
export async function summarizeRecentDeliveries(sinceMs: number): Promise<readonly DeliverySiteSummary[]> {
  const { rows } = await sql<{ code: string; days: number; total_kg: number; last_ms: number }>`
    SELECT s.code,
      count(DISTINCT (d.delivered_at AT TIME ZONE 'Asia/Seoul')::date)::int AS days,
      sum(d.mass_kg)::float8 AS total_kg,
      (extract(epoch FROM max(d.delivered_at)) * 1000)::float8 AS last_ms
    FROM om.h2_delivery d JOIN om.site s ON s.id = d.site_id
    WHERE d.delivered_at >= ${new Date(sinceMs).toISOString()}::timestamptz
    GROUP BY s.code
    ORDER BY s.code
  `.execute(db);
  return rows.map((r) => ({ siteCode: r.code, days: r.days, totalKg: r.total_kg, lastDeliveredAtMs: r.last_ms }));
}
