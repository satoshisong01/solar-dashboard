// sim:backfill 뒤 정답 운영 이벤트를 om.asset_event에 멱등 기록한다 (hysol_test, 시드된 SIM 사이트).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_SITES } from '@/db/seed/sites';
import { seedDatabase } from '@/lib/db/seed';
import { recordAssetEvents, SIM_EVENT_ACTOR } from '@/lib/sim/asset-events-store';
import type { AssetEventTruth } from '@/lib/sim/truth';
import { createTestDb, testEncryptionKey } from '../support/ingest-fixture';

describe('시뮬레이션 운영 이벤트 기록 (hysol_test)', () => {
  const db = createTestDb();
  const event: AssetEventTruth = { siteCode: 'SIM-B', assetPath: 'SIM-B/ESS1', ts: Date.UTC(2001, 0, 2), kind: 'setpoint_change', resetsBaseline: false, note: 'EMS 충전 SOC 상한 90% → 80% (integration)' };
  const cleanup = () => db.deleteFrom('om.asset_event').where('created_by', '=', SIM_EVENT_ACTOR).where('ts', '=', new Date(event.ts)).execute();

  beforeAll(async () => {
    const gatewaySecrets = new Map(SIM_SITES.map(({ gateway }) => [gateway.code, process.env[gateway.secretEnvVar] ?? randomBytes(32).toString('base64url')]));
    await seedDatabase(db, { encryptionKey: testEncryptionKey(), gatewaySecrets });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('설비 경로로 찾아 넣고, 다시 넣으면 건너뛰며, 없는 설비는 알려 준다', async () => {
    expect(await recordAssetEvents(db, [event, { ...event, assetPath: 'SIM-X/ESS1' }])).toEqual({ inserted: 1, existing: 0, missingAssets: ['SIM-X/ESS1'] });
    expect(await recordAssetEvents(db, [event])).toEqual({ inserted: 0, existing: 1, missingAssets: [] });
    const rows = await db.selectFrom('om.asset_event as e').innerJoin('om.asset as a', 'a.id', 'e.asset_id').select(['a.path', 'e.kind', 'e.resets_baseline']).where('e.created_by', '=', SIM_EVENT_ACTOR).where('e.ts', '=', new Date(event.ts)).execute();
    expect(rows).toEqual([{ path: 'SIM-B/ESS1', kind: 'setpoint_change', resets_baseline: false }]);
  });
});
