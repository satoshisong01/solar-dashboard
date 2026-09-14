import 'server-only';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';

export interface NameplateEntry {
  readonly key: string;
  readonly title: string;
  readonly value: string;
}

export interface AssetLink {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly level: string;
  readonly className: string;
}

export interface AssetDetail {
  readonly id: number;
  readonly siteId: number;
  readonly siteCode: string;
  readonly siteName: string;
  readonly code: string;
  readonly path: string;
  readonly name: string;
  readonly level: string;
  readonly classKey: string;
  readonly className: string;
  readonly criticality: number;
  readonly peerGroup: string | null;
  /** YYYY-MM-DD (date 컬럼을 문자열로 읽어 시간대 변환을 피한다) */
  readonly commissionedAt: string | null;
  readonly nameplate: readonly NameplateEntry[];
  readonly parent: AssetLink | null;
  readonly children: readonly AssetLink[];
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** 명판 값을 설비 종류의 JSON Schema 속성 순서·제목으로 정리한다. 스키마에 없는 키는 뒤에 키 이름으로 붙인다 */
function toNameplateEntries(nameplate: unknown, schema: unknown): NameplateEntry[] {
  const values = asRecord(nameplate);
  const properties = asRecord(asRecord(schema).properties);
  const titleOf = (key: string) => {
    const title = asRecord(properties[key]).title;
    return typeof title === 'string' ? title : key;
  };
  const keys = [...Object.keys(properties).filter((key) => key in values), ...Object.keys(values).filter((key) => !(key in properties))];
  return keys.map((key) => {
    const value = values[key];
    return { key, title: titleOf(key), value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) };
  });
}

/** 사이트 코드와 설비 id가 함께 맞을 때만 돌려준다 (다른 사이트 설비를 URL로 섞어 보지 않도록) */
export async function getAssetDetail(siteCode: string, assetId: number): Promise<AssetDetail | null> {
  const row = await db
    .selectFrom('om.asset as a')
    .innerJoin('om.site as s', 's.id', 'a.site_id')
    .innerJoin('om.asset_class as c', 'c.key', 'a.class_key')
    .select([
      'a.id',
      'a.site_id',
      's.code as site_code',
      's.name as site_name',
      'a.parent_id',
      'a.code',
      'a.path',
      'a.name',
      'a.level',
      'a.class_key',
      'c.name_ko as class_name',
      'c.nameplate_schema',
      'a.nameplate',
      'a.criticality',
      'a.peer_group',
      sql<string | null>`to_char(a.commissioned_at, 'YYYY-MM-DD')`.as('commissioned_at'),
    ])
    .where('a.id', '=', assetId)
    .where('s.code', '=', siteCode)
    .executeTakeFirst();
  if (!row) return null;

  const links = await db
    .selectFrom('om.asset as a')
    .innerJoin('om.asset_class as c', 'c.key', 'a.class_key')
    .select(['a.id', 'a.code', 'a.name', 'a.level', 'a.parent_id', 'c.name_ko as class_name'])
    .where((eb) => eb.or([eb('a.parent_id', '=', row.id), ...(row.parent_id === null ? [] : [eb('a.id', '=', row.parent_id)])]))
    .orderBy('a.code')
    .execute();
  const toLink = (link: (typeof links)[number]): AssetLink => ({
    id: link.id,
    code: link.code,
    name: link.name,
    level: link.level,
    className: link.class_name,
  });
  const parent = links.find((link) => link.id === row.parent_id);

  return {
    id: row.id,
    siteId: row.site_id,
    siteCode: row.site_code,
    siteName: row.site_name,
    code: row.code,
    path: row.path,
    name: row.name,
    level: row.level,
    classKey: row.class_key,
    className: row.class_name,
    criticality: row.criticality,
    peerGroup: row.peer_group,
    commissionedAt: row.commissioned_at,
    nameplate: toNameplateEntries(row.nameplate, row.nameplate_schema),
    parent: parent ? toLink(parent) : null,
    children: links.filter((link) => link.parent_id === row.id).map(toLink),
  };
}
