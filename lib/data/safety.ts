import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import type { SilenceGateway, SilenceSite } from './safety-silence';
import { toSeverity, type EventSeverity } from './severity';

export interface SafetyEventRow {
  readonly id: string;
  readonly tsMs: number;
  /** 서버 수신 시각. 수신 시각 기록 전(마이그레이션 이전)에 받은 이벤트는 null */
  readonly receivedAtMs: number | null;
  readonly siteCode: string;
  readonly assetId: number | null;
  readonly assetCode: string | null;
  readonly assetName: string | null;
  readonly gatewayCode: string;
  readonly sourceKey: string;
  readonly code: string;
  readonly severity: EventSeverity;
  readonly text: string | null;
  readonly ackedAtMs: number | null;
  readonly ackedBy: string | null;
  readonly ackNote: string | null;
}

const toMs = (value: Date | null) => (value === null ? null : value.getTime());

function baseQuery() {
  return db
    .selectFrom('om.event_log as e')
    .innerJoin('om.site as s', 's.id', 'e.site_id')
    .innerJoin('om.gateway as g', 'g.id', 'e.gateway_id')
    .leftJoin('om.asset as a', 'a.id', 'e.asset_id')
    .select([
      'e.id',
      'e.ts',
      'e.received_at',
      's.code as site_code',
      'e.asset_id',
      'a.code as asset_code',
      'a.name as asset_name',
      'g.code as gateway_code',
      'e.source_key',
      'e.code',
      'e.severity',
      'e.text',
      'e.acked_at',
      'e.acked_by',
      'e.ack_note',
    ])
    .where('e.is_safety', '=', true);
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

const toRow = (row: BaseRow): SafetyEventRow => ({
  id: row.id,
  tsMs: row.ts.getTime(),
  receivedAtMs: toMs(row.received_at),
  siteCode: row.site_code,
  assetId: row.asset_id,
  assetCode: row.asset_code,
  assetName: row.asset_name,
  gatewayCode: row.gateway_code,
  sourceKey: row.source_key,
  code: row.code,
  severity: toSeverity(row.severity),
  text: row.text,
  ackedAtMs: toMs(row.acked_at),
  ackedBy: row.acked_by,
  ackNote: row.ack_note,
});

export interface UnackedSafetyEvents {
  readonly total: number;
  /** 최근 발생부터 limit건 */
  readonly rows: readonly SafetyEventRow[];
}

/** 확인되지 않은 안전 이벤트 (기간 제한 없음: 자동 해제가 없다) */
export async function getUnackedSafetyEvents(limit: number): Promise<UnackedSafetyEvents> {
  const [rows, count] = await Promise.all([
    baseQuery().where('e.acked_at', 'is', null).orderBy('e.ts', 'desc').orderBy('e.id', 'desc').limit(limit).execute(),
    db
      .selectFrom('om.event_log')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('is_safety', '=', true)
      .where('acked_at', 'is', null)
      .executeTakeFirst(),
  ]);
  return { total: count?.n ?? 0, rows: rows.map(toRow) };
}

/** 최근 확인한 안전 이벤트부터 */
export async function getSafetyAckHistory(limit: number): Promise<readonly SafetyEventRow[]> {
  const rows = await baseQuery().where('e.acked_at', 'is not', null).orderBy('e.acked_at', 'desc').orderBy('e.id', 'desc').limit(limit).execute();
  return rows.map(toRow);
}

/** 안전감시 공백 판정 입력: 사이트별 설비 종류와 게이트웨이 마지막 수신 */
export async function getSafetySilenceInputs(): Promise<Readonly<{ sites: readonly SilenceSite[]; gateways: readonly SilenceGateway[] }>> {
  const [sites, classes, gateways] = await Promise.all([
    db.selectFrom('om.site').select(['id', 'code']).execute(),
    db.selectFrom('om.asset').select(['site_id', 'class_key']).distinct().execute(),
    db.selectFrom('om.gateway').select(['site_id', 'code', 'status', 'last_seen_at']).execute(),
  ]);
  return {
    sites: sites.map((site) => ({
      siteId: site.id,
      siteCode: site.code,
      classKeys: classes.filter((row) => row.site_id === site.id).map((row) => row.class_key),
    })),
    gateways: gateways.map((gateway) => ({
      siteId: gateway.site_id,
      code: gateway.code,
      status: gateway.status,
      lastSeenMs: toMs(gateway.last_seen_at),
    })),
  };
}
