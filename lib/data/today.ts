import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { formatKstDate } from '@/lib/format';
import { getEnergyByWindows, type EnergyValues } from './energy';
import { getEvents, type EventRow } from './sites';
import { kstMonthStartMs, yesterdayAndToday } from './time';

const BANNER_EVENT_LIMIT = 3;

export interface SafetyBanner {
  readonly count: number;
  readonly latest: readonly EventRow[];
}

/** 확인되지 않은 안전 이벤트 수와 최근 몇 건 (기간 제한 없음: ack 전까지 고정 표시) */
export async function getSafetyBanner(): Promise<SafetyBanner> {
  const [countRow, latest] = await Promise.all([
    db
      .selectFrom('om.event_log')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('is_safety', '=', true)
      .where('acked_at', 'is', null)
      .executeTakeFirst(),
    getEvents({ unackedSafetyOnly: true, limit: BANNER_EVENT_LIMIT }),
  ]);
  return { count: countRow?.n ?? 0, latest };
}

/** 이 시간 넘게 배치를 보내지 않은 활성 게이트웨이를 공백으로 본다 */
export const GATEWAY_SILENCE_MS = 15 * 60_000;

export interface DataGaps {
  readonly staleGateways: readonly Readonly<{ code: string; siteCode: string; lastSeenMs: number | null }>[];
  readonly activeGateways: number;
  /** 아직 point로 매핑되지 않은 수신 태그 수 */
  readonly unmappedTags: number;
}

export async function getDataGaps(nowMs: number): Promise<DataGaps> {
  const threshold = new Date(nowMs - GATEWAY_SILENCE_MS);
  const [gateways, unmapped] = await Promise.all([
    db
      .selectFrom('om.gateway as g')
      .innerJoin('om.site as s', 's.id', 'g.site_id')
      .select(['g.code', 's.code as site_code', 'g.last_seen_at'])
      .where('g.status', '=', 'active')
      .orderBy('s.code')
      .orderBy('g.code')
      .execute(),
    db
      .selectFrom('om.unmapped_source as u')
      .select(sql<number>`count(*)::int`.as('n'))
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('om.point as p')
              .select('p.id')
              .whereRef('p.gateway_id', '=', 'u.gateway_id')
              .whereRef('p.source_key', '=', 'u.source_key'),
          ),
        ),
      )
      .executeTakeFirst(),
  ]);

  return {
    staleGateways: gateways
      .filter((g) => g.last_seen_at === null || g.last_seen_at < threshold)
      .map((g) => ({ code: g.code, siteCode: g.site_code, lastSeenMs: g.last_seen_at ? g.last_seen_at.getTime() : null })),
    activeGateways: gateways.length,
    unmappedTags: unmapped?.n ?? 0,
  };
}

export interface SiteEnergySummary {
  readonly siteId: number;
  readonly code: string;
  readonly name: string;
  readonly yesterday: EnergyValues;
  readonly today: EnergyValues;
}

/** 사이트별 어제(KST)·오늘(KST 00:00 ~ now) 발전·수소 요약 */
export async function getEnergySummary(nowMs: number): Promise<readonly SiteEnergySummary[]> {
  const sites = await db.selectFrom('om.site').select(['id', 'code', 'name']).orderBy('code').execute();
  if (sites.length === 0) return [];
  const { yesterday, today } = yesterdayAndToday(nowMs);
  const bySite = await getEnergyByWindows([yesterday, today], sites.map((site) => site.id));
  return sites.flatMap((site) => {
    const values = bySite.get(site.id);
    if (!values || values.length < 2) return [];
    return [{ siteId: site.id, code: site.code, name: site.name, yesterday: values[0], today: values[1] }];
  });
}

export const MARKET_LABELS: Readonly<Record<string, string>> = {
  smp_land: 'SMP (육지)',
  smp_jeju: 'SMP (제주)',
  rec_avg: 'REC 평균',
};

export interface MarketSummaryRow {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly latestDay: string;
  readonly latestValue: number;
  /** 이번 달(KST) 입력 일수와 평균. 이번 달 입력이 없으면 0과 null */
  readonly monthDays: number;
  readonly monthAvg: number | null;
}

/** om.market_daily의 항목별 최근값과 이번 달 평균 (수기 입력·CSV) */
export async function getMarketSummary(nowMs: number): Promise<readonly MarketSummaryRow[]> {
  const monthStart = formatKstDate(kstMonthStartMs(nowMs));
  const { rows } = await sql<{
    market_key: string;
    unit: string;
    latest_day: string;
    latest_value: number;
    month_days: number;
    month_avg: number | null;
  }>`
    SELECT DISTINCT ON (d.market_key)
      d.market_key, d.unit, to_char(d.day, 'YYYY-MM-DD') AS latest_day, d.value::float8 AS latest_value,
      (SELECT count(*) FROM om.market_daily x WHERE x.market_key = d.market_key AND x.day >= ${monthStart}::date)::int AS month_days,
      (SELECT avg(x.value)::float8 FROM om.market_daily x WHERE x.market_key = d.market_key AND x.day >= ${monthStart}::date) AS month_avg
    FROM om.market_daily d
    ORDER BY d.market_key, d.day DESC
  `.execute(db);

  return rows.map((row) => ({
    key: row.market_key,
    label: MARKET_LABELS[row.market_key] ?? row.market_key,
    unit: row.unit,
    latestDay: row.latest_day,
    latestValue: row.latest_value,
    monthDays: row.month_days,
    monthAvg: row.month_avg,
  }));
}
