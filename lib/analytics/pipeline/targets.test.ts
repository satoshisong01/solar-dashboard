import { describe, expect, it } from 'vitest';
import { DETECTORS } from '../detectors';
import { MS_PER_DAY } from '../types';
import { PIPELINE_DETECTOR_IDS, runSiteDetectors } from './detect';
import { allowedScopeKinds, DETECTOR_TARGETING, targetingOf } from './targets';
import type { DetectorConfigRow, PipelineAsset } from './types';

const NOW = Date.parse('2026-09-01T00:00:00Z');

const asset = (id: number, code: string, classKey: string, extra: Partial<PipelineAsset> = {}): PipelineAsset => ({ id, siteId: 4, parentId: null, code, classKey, peerGroup: null, nameplate: {}, commissionedAt: null, ...extra });

const SITE: readonly PipelineAsset[] = [
  asset(1, 'ESS1', 'ess.plant'),
  asset(2, 'ESS1/RACK01', 'ess.rack', { parentId: 1, nameplate: { capacity_ah: 400 } }),
  asset(10, 'PV1', 'pv.plant'),
  ...[11, 12, 13].map((id, i) => asset(id, `PV1/INV0${i + 1}`, 'pv.inverter', { parentId: 10, peerGroup: 'S/pv.inverter', nameplate: { ac_kw: 250, dc_kwp: 250 } })),
  asset(20, 'WX1', 'wx.station'),
  asset(30, 'ELZ1', 'h2.elz'),
  asset(31, 'ELZ1/STACK1', 'h2.elz.stack', { parentId: 30 }),
  asset(40, 'COMP1', 'h2.compressor'),
  asset(50, 'H2BANK1', 'h2.storage.bank'),
  asset(51, 'H2BANK1/TANK1', 'h2.storage.tank', { parentId: 50 }),
  asset(60, 'FC1', 'fc.plant'),
  asset(61, 'FC1/STACK1', 'fc.stack', { parentId: 60 }),
  asset(62, 'FC1/BLOWER1', 'fc.blower', { parentId: 60 }),
];

/** 모든 탐지기에 모든 범위(default · 사이트 설비 종류 전부 · 설비 전부) 설정 행을 둔다 */
const CONFIGS: readonly DetectorConfigRow[] = PIPELINE_DETECTOR_IDS.flatMap((detectorId) => [
  { detectorId, scope: 'default', version: 1, params: {}, referenceWindow: null },
  ...[...new Set(SITE.map((a) => a.classKey))].map((classKey) => ({ detectorId, scope: `class:${classKey}`, version: 1, params: {}, referenceWindow: null })),
  ...SITE.map((a) => ({ detectorId, scope: `asset:${a.id}`, version: 1, params: {}, referenceWindow: null })),
]);

describe('DETECTOR_TARGETING', () => {
  it('실제 실행에서 적용된 설정 범위가 표(configClass·assetScope)와 같다', () => {
    const outcomes = runSiteDetectors(
      { siteId: 4, assets: SITE, episodes: [], events: [], configs: CONFIGS, dq: { siteId: 4, window: { start: NOW - 7 * MS_PER_DAY, end: NOW }, points: [] }, aux: { ledgerDays: [] } },
      { now: NOW, seed: 1 },
    );
    for (const detectorId of PIPELINE_DETECTOR_IDS) {
      const targeting = DETECTOR_TARGETING[detectorId];
      const applied = new Set(outcomes.filter((o) => o.detectorId === detectorId).flatMap((o) => o.configVersions));
      const expected = new Set([
        'default@1',
        ...(targeting.configClass === null ? [] : [`class:${targeting.configClass}@1`]),
        ...(targeting.assetScope ? SITE.filter((a) => a.classKey === targeting.configClass).map((a) => `asset:${a.id}@1`) : []),
      ]);
      expect([detectorId, [...applied].sort()]).toEqual([detectorId, [...expected].sort()]);
    }
  });

  it('설비 단위 탐지기의 대상 종류는 레지스트리 requires 첫 종류, 범위 선택지는 표를 따른다', () => {
    for (const detector of DETECTORS) {
      const targeting = targetingOf(detector.id);
      expect(targeting).not.toBeNull();
      if (targeting?.targetClass) expect([detector.id, detector.requires.assetClass[0]]).toEqual([detector.id, targeting.targetClass]);
    }
    expect(targetingOf('nope.detector')).toBeNull();
    expect(allowedScopeKinds(DETECTOR_TARGETING['ess.capacity_fade'])).toEqual(['default', 'class', 'asset']);
    expect(allowedScopeKinds(DETECTOR_TARGETING['pv.inverter_peer'])).toEqual(['default', 'class']);
    expect(allowedScopeKinds(DETECTOR_TARGETING['h2chain.mass_balance_gap'])).toEqual(['default']);
  });
});
