import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { CLOSED_STATUSES } from '@/lib/analysis/transition-rules';
import { SAFETY_FINDING_MIN_SEVERITY } from '@/lib/desk/safety';
import { formatKstDate } from '@/lib/format';
import { isMarketKey, MARKET_LABELS } from '@/lib/market/keys';
import { getEnergyByWindows, type EnergyValues } from './energy';
import { safetyFindingsBanner, type SafetyFindingsBanner } from './safety-banner';
import { getEvents, type EventRow } from './sites';
import { kstMonthStartMs, yesterdayAndToday } from './time';

const BANNER_EVENT_LIMIT = 3;

export interface SafetyBanner {
  readonly count: number;
  readonly latest: readonly EventRow[];
  /** 열린 안전 발견사항 (분석 결과, 이벤트와 따로 표시) */
  readonly findings: SafetyFindingsBanner;
}

/** 열린 안전 발견사항 후보 (안전 카테고리·심각도 4 이상, 닫힌 상태 제외). 최종 규칙은 lib/data/safety-banner.ts */
async function loadSafetyFindings(): Promise<SafetyFindingsBanner> {
  const rows = await db
    .selectFrom('om.finding as f')
    .innerJoin('om.site as s', 's.id', 'f.site_id')
    .leftJoin('om.asset as a', 'a.id', 'f.asset_id')
    .select(['f.id', 's.code as site_code', 'a.path as asset_path', 'f.detector_id', 'f.category', 'f.severity', 'f.status', 'f.title', 'f.last_detected_at'])
    .where('f.category', '=', 'safety')
    .where('f.severity', '>=', SAFETY_FINDING_MIN_SEVERITY)
    .where('f.status', 'not in', [...CLOSED_STATUSES])
    .execute();
  return safetyFindingsBanner(rows.map((r) => ({ id: r.id, siteCode: r.site_code, assetPath: r.asset_path, detectorId: r.detector_id, category: r.category, severity: r.severity, status: r.status, title: r.title, lastDetectedMs: r.last_detected_at.getTime() })));
}

/** 확인되지 않은 안전 이벤트 수와 최근 몇 건 (기간 제한 없음: ack 전까지 고정 표시) + 열린 안전 발견사항 */
export async function getSafetyBanner(): Promise<SafetyBanner> {
  const [countRow, latest, findings] = await Promise.all([
    db
      .selectFrom('om.event_log')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('is_safety', '=', true)
      .where('acked_at', 'is', null)
      .executeTakeFirst(),
    getEvents({ unackedSafetyOnly: true, limit: BANNER_EVENT_LIMIT }),
    loadSafetyFindings(),
  ]);
  return { count: countRow?.n ?? 0, latest, findings };
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
    label: isMarketKey(row.market_key) ? MARKET_LABELS[row.market_key] : row.market_key,
    unit: row.unit,
    latestDay: row.latest_day,
    latestValue: row.latest_value,
    monthDays: row.month_days,
    monthAvg: row.month_avg,
  }));
}
