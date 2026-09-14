import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from '../support/test-env';

const databaseUrl = assertTestDatabaseUrl(process.env.DATABASE_URL);

const OM_TABLES = [
  'action_verification', 'analysis_run', 'asset', 'asset_class', 'asset_event', 'detector_config', 'episode', 'event_log',
  'finding', 'finding_evidence', 'finding_transition', 'gateway', 'gateway_key', 'ingest_batch', 'kpi_daily', 'm_1h',
  'maintenance_action', 'market_daily', 'measurement', 'metric_def', 'point', 'report', 'rollup_dirty', 'site', 'unmapped_source',
];

/** UTC 기준 오늘에서 offset개월 떨어진 달의 파티션 이름 */
function monthPartitionName(offset: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `measurement_y${month.getUTCFullYear()}m${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('om 스키마 (hysol_test)', () => {
  const client = new pg.Client({ connectionString: databaseUrl });

  beforeAll(() => client.connect());
  afterAll(() => client.end());
  // 각 테스트는 트랜잭션 안에서 실행하고 되돌린다 (DDL 포함).
  afterEach(() => client.query('ROLLBACK'));

  async function partitionsOf(parent: string): Promise<string[]> {
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = $1::regclass ORDER BY 1`,
      [`om.${parent}`],
    );
    return rows.map((row) => row.name);
  }

  it('P1·P2 테이블이 모두 있다 (파티션 자식 제외)', async () => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'om' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(OM_TABLES);
  });

  it('measurement는 현재 기준 -3~+3개월 UTC 월 파티션과 DEFAULT를 갖는다', async () => {
    const partitions = await partitionsOf('measurement');
    const expected = [-3, -2, -1, 0, 1, 2, 3].map(monthPartitionName);

    expect(partitions).toEqual(expect.arrayContaining([...expected, 'measurement_default']));
  });

  it('measurement 파티션마다 BRIN(minmax_multi, pages_per_range=64, autosummarize) 인덱스가 있다', async () => {
    const { rows } = await client.query<{ partition: string; opclass: string; options: string[] | null }>(
      `SELECT t.relname AS partition, oc.opcname AS opclass, ic.reloptions AS options
       FROM pg_inherits i
       JOIN pg_class t ON t.oid = i.inhrelid
       JOIN pg_index x ON x.indrelid = t.oid
       JOIN pg_class ic ON ic.oid = x.indexrelid
       JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'brin'
       JOIN pg_opclass oc ON oc.oid = x.indclass[0]
       WHERE i.inhparent = 'om.measurement'::regclass`,
    );
    const partitions = await partitionsOf('measurement');

    expect(rows.map((row) => row.partition).sort()).toEqual(partitions);
    for (const row of rows) {
      expect(row.opclass).toBe('timestamptz_minmax_multi_ops');
      expect(row.options).toEqual(expect.arrayContaining(['pages_per_range=64', 'autosummarize=on']));
    }
  });

  it('m_1h는 작년·올해·내년 연 파티션과 DEFAULT를 갖는다', async () => {
    const year = new Date().getUTCFullYear();

    expect(await partitionsOf('m_1h')).toEqual(
      expect.arrayContaining([`m_1h_y${year - 1}`, `m_1h_y${year}`, `m_1h_y${year + 1}`, 'm_1h_default']),
    );
  });

  it('ensure_measurement_partitions는 멱등이고 DEFAULT에 먼저 들어온 행을 새 파티션으로 옮긴다', async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO om.measurement (point_id, ts, value) VALUES
         (-1, '2031-02-10T00:00:00Z', 1.5), (-1, '2031-03-10T00:00:00Z', 2.5)`,
    );

    const first = await client.query<{ created: number }>("SELECT om.ensure_measurement_partitions('2031-02-20', 1) AS created");
    const second = await client.query<{ created: number }>("SELECT om.ensure_measurement_partitions('2031-02-01', 1) AS created");
    const { rows } = await client.query<{ partition: string; value: number }>(
      'SELECT tableoid::regclass::text AS partition, value FROM om.measurement WHERE point_id = -1 ORDER BY ts',
    );

    expect(first.rows[0]?.created).toBe(1);
    expect(second.rows[0]?.created).toBe(0);
    expect(rows).toEqual([
      { partition: 'om.measurement_y2031m02', value: 1.5 },
      { partition: 'om.measurement_default', value: 2.5 },
    ]);
  });

  it('ensure_m1h_partitions는 없는 연도만 만든다', async () => {
    await client.query('BEGIN');
    const created = await client.query<{ created: number }>("SELECT om.ensure_m1h_partitions('2031-06-01', 2) AS created");
    const again = await client.query<{ created: number }>("SELECT om.ensure_m1h_partitions('2031-01-01', 2) AS created");

    expect(created.rows[0]?.created).toBe(2);
    expect(again.rows[0]?.created).toBe(0);
  });

  it('게이트웨이당 활성 키는 2개까지만 허용하고, 폐기하면 새 키를 추가할 수 있다', async () => {
    await client.query('BEGIN');
    const site = await client.query<{ id: number }>("INSERT INTO om.site (code, name) VALUES ('TEST-KEY', '키 테스트') RETURNING id");
    const gateway = await client.query<{ id: number }>(
      "INSERT INTO om.gateway (site_id, code) VALUES ($1, 'GW-TEST-KEY') RETURNING id",
      [site.rows[0]?.id],
    );
    const gatewayId = gateway.rows[0]?.id;
    const addKey = (keyId: string) =>
      client.query("INSERT INTO om.gateway_key (key_id, gateway_id, secret_enc) VALUES ($1, $2, '\\x01')", [keyId, gatewayId]);

    await addKey('gk_test_1');
    await addKey('gk_test_2');
    await client.query('SAVEPOINT third_key');
    await expect(addKey('gk_test_3')).rejects.toThrow(/활성 키는 최대 2개/);
    await client.query('ROLLBACK TO SAVEPOINT third_key');

    await client.query("UPDATE om.gateway_key SET revoked_at = now() WHERE key_id = 'gk_test_1'");
    await expect(addKey('gk_test_3')).resolves.toBeDefined();
  });

  it('원시 측정값을 지우는 보존 함수는 없다', async () => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'om' ORDER BY 1`,
    );

    expect(rows.map((row) => row.name)).toEqual([
      'create_range_partition',
      'ensure_m1h_partitions',
      'ensure_measurement_partitions',
      'gateway_key_limit_active',
    ]);
  });
});
