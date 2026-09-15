// 탐지기 설정 버전 저장·활성 전환 (lib/ops/detector-config.ts) — 설정 화면 Server Action이 부르는 DB 변경.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadActiveDetectorConfigs } from '@/lib/analysis/catalog';
import { createDetectorConfigVersion, loadDetectorConfigVersions, setDetectorConfigActive } from '@/lib/ops/detector-config';
import { createTestDb } from '../support/ingest-fixture';

const DETECTOR = 'itest.detector_config';
const WINDOW = { startMs: Date.parse('2026-05-31T15:00:00Z'), endMs: Date.parse('2026-06-30T15:00:00Z') }; // KST 2026-06-01 ~ 06-30

describe('탐지기 설정 버전 (hysol_test)', () => {
  const db = createTestDb();
  const cleanup = () => sql`DELETE FROM om.detector_config WHERE detector_id = ${DETECTOR}`.execute(db);

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('새 버전은 최대 + 1로 활성, 같은 범위 이전 활성은 꺼지고 다른 범위는 그대로', async () => {
    expect(await createDetectorConfigVersion(db, { detectorId: DETECTOR, scope: 'default', params: { residualPct: 3 }, referenceWindow: null, actor: 'itest' })).toBe(1);
    expect(await createDetectorConfigVersion(db, { detectorId: DETECTOR, scope: 'class:h2.elz', params: {}, referenceWindow: null, actor: 'itest' })).toBe(1);
    expect(await createDetectorConfigVersion(db, { detectorId: DETECTOR, scope: 'default', params: { residualPct: 2.5, useX: false, auto: null }, referenceWindow: WINDOW, actor: 'itest' })).toBe(2);

    const versions = await loadDetectorConfigVersions(db, DETECTOR);
    expect(versions.map((v) => [v.scope, v.version, v.active])).toEqual([
      ['class:h2.elz', 1, true],
      ['default', 1, false],
      ['default', 2, true],
    ]);
    expect(versions[2]).toMatchObject({ params: { residualPct: 2.5, useX: false, auto: null }, referenceWindow: { startDay: '2026-06-01', endDay: '2026-06-30' }, createdBy: 'itest' });

    const active = (await loadActiveDetectorConfigs(db)).filter((c) => c.detectorId === DETECTOR);
    expect(active.find((c) => c.scope === 'default')).toMatchObject({ version: 2, referenceWindow: { start: WINDOW.startMs, end: WINDOW.endMs } });
  });

  it('활성 전환: 켜면 같은 범위 다른 활성을 끄고, 끄면 활성 없음, 없는 버전은 not_found', async () => {
    expect(await setDetectorConfigActive(db, { detectorId: DETECTOR, scope: 'default', version: 1, active: true })).toBe('saved');
    const afterOn = await loadDetectorConfigVersions(db, DETECTOR);
    expect(afterOn.filter((v) => v.scope === 'default').map((v) => [v.version, v.active])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(await setDetectorConfigActive(db, { detectorId: DETECTOR, scope: 'default', version: 1, active: false })).toBe('saved');
    expect((await loadDetectorConfigVersions(db, DETECTOR)).filter((v) => v.scope === 'default' && v.active)).toEqual([]);
    expect(await setDetectorConfigActive(db, { detectorId: DETECTOR, scope: 'default', version: 9, active: true })).toBe('not_found');
  });

  it('같은 범위 동시 저장도 버전이 겹치지 않고 활성은 하나', async () => {
    const created = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createDetectorConfigVersion(db, { detectorId: DETECTOR, scope: 'asset:7', params: { residualPct: 2 + i / 10 }, referenceWindow: null, actor: `itest-${i}` })),
    );
    expect([...created].sort()).toEqual([1, 2, 3, 4]);
    const rows = (await loadDetectorConfigVersions(db, DETECTOR)).filter((v) => v.scope === 'asset:7');
    expect(rows.filter((v) => v.active).map((v) => v.version)).toEqual([4]);
  });
});
