import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';

export interface AssetClassRow {
  readonly key: string;
  readonly level: string;
  readonly parentKey: string | null;
  readonly nameKo: string;
  readonly safetyEventCodes: readonly string[];
  readonly assetCount: number;
}

export async function listAssetClasses(): Promise<readonly AssetClassRow[]> {
  const rows = await db
    .selectFrom('om.asset_class as c')
    .select((eb) => [
      'c.key',
      'c.level',
      'c.parent_key',
      'c.name_ko',
      'c.safety_event_codes',
      eb.selectFrom('om.asset as a').select(sql<number>`count(*)::int`.as('n')).whereRef('a.class_key', '=', 'c.key').as('asset_count'),
    ])
    .orderBy('c.key')
    .execute();
  return rows.map((row) => ({
    key: row.key,
    level: row.level,
    parentKey: row.parent_key,
    nameKo: row.name_ko,
    safetyEventCodes: row.safety_event_codes,
    assetCount: row.asset_count ?? 0,
  }));
}

export interface MetricDefRow {
  readonly key: string;
  readonly nameKo: string;
  readonly quantity: string;
  readonly unit: string;
  readonly valueKind: string;
  readonly rollup: string;
  readonly hardMin: number | null;
  readonly hardMax: number | null;
  readonly expectedMin: number | null;
  readonly expectedMax: number | null;
  readonly flatlineMaxS: number | null;
  readonly aliases: readonly string[];
  readonly pointCount: number;
}

const toAliases = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function metricQuery() {
  return db
    .selectFrom('om.metric_def as m')
    .select((eb) => [
      'm.key',
      'm.name_ko',
      'm.quantity',
      'm.unit',
      'm.value_kind',
      'm.rollup',
      'm.hard_min',
      'm.hard_max',
      'm.expected_min',
      'm.expected_max',
      'm.flatline_max_s',
      'm.aliases',
      eb.selectFrom('om.point as p').select(sql<number>`count(*)::int`.as('n')).whereRef('p.metric_key', '=', 'm.key').as('point_count'),
    ]);
}

type MetricDbRow = Awaited<ReturnType<ReturnType<typeof metricQuery>['execute']>>[number];

const toMetricRow = (row: MetricDbRow): MetricDefRow => ({
  key: row.key,
  nameKo: row.name_ko,
  quantity: row.quantity,
  unit: row.unit,
  valueKind: row.value_kind,
  rollup: row.rollup,
  hardMin: row.hard_min,
  hardMax: row.hard_max,
  expectedMin: row.expected_min,
  expectedMax: row.expected_max,
  flatlineMaxS: row.flatline_max_s,
  aliases: toAliases(row.aliases),
  pointCount: row.point_count ?? 0,
});

/** LIKE 특수문자를 글자로 취급한다 */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 키·이름·물리량·별칭에 검색어가 들어간 메트릭 (대소문자 무시). 검색어가 없으면 전체. 키 순 */
export async function listMetricDefs(search = ''): Promise<readonly MetricDefRow[]> {
  const term = search.trim();
  let query = metricQuery().orderBy('m.key');
  if (term !== '') {
    const pattern = `%${escapeLike(term)}%`;
    query = query.where(sql<boolean>`(m.key ILIKE ${pattern} OR m.name_ko ILIKE ${pattern} OR m.quantity ILIKE ${pattern} OR m.aliases::text ILIKE ${pattern})`);
  }
  const rows = await query.execute();
  return rows.map(toMetricRow);
}

export async function getMetricDef(key: string): Promise<MetricDefRow | null> {
  const row = await metricQuery().where('m.key', '=', key).executeTakeFirst();
  return row ? toMetricRow(row) : null;
}
