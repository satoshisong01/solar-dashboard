import { describe, expect, it } from 'vitest';
import { capacityHistory, DAY0, elRuns, pvDay } from '../detectors/test-fixtures';
import { essChargeCycle, T0 } from '../episodes/test-fixtures';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../types';
import { resolveDetectorConfig } from './config';
import { runSiteDetectors } from './detect';
import { extractAssetEpisodes, NameplateError, nameplateNumber } from './extract';
import { indexSnapshot, type SiteSnapshot } from './snapshot';
import { seriesRequests } from './sources';
import type { DetectorConfigRow, PipelineAsset, StoredEpisode } from './types';

const asset = (id: number, code: string, classKey: string, extra: Partial<PipelineAsset> = {}): PipelineAsset => ({
  id,
  siteId: 1,
  parentId: null,
  code,
  classKey,
  peerGroup: null,
  nameplate: {},
  commissionedAt: DAY0 - MS_PER_DAY,
  ...extra,
});

const SITE: readonly PipelineAsset[] = [
  asset(1, 'ESS1', 'ess.plant'),
  ...[7, 8, 9].map((id, i) => asset(id, `ESS1/RACK0${i + 1}`, 'ess.rack', { parentId: 1, peerGroup: 'S/ess.rack', nameplate: { capacity_ah: 400 } })),
  asset(20, 'WX1', 'wx.station'),
  ...[1, 2, 3, 4].map((i) => asset(i + 100, `PV1/INV0${i}`, 'pv.inverter', { peerGroup: 'S/pv.inverter', nameplate: { ac_kw: 250, dc_kwp: 250 } })),
  asset(30, 'ELZ1', 'h2.elz'),
  asset(31, 'ELZ1/STACK1', 'h2.elz.stack', { parentId: 30, nameplate: { cell_count: 210, active_area_cm2: 550, rated_current_a: 1100 } }),
  asset(40, 'FC1', 'fc.plant'),
  asset(41, 'FC1/STACK1', 'fc.stack', { parentId: 40, nameplate: { cell_count: 400, active_area_cm2: 800, rated_current_a: 820 } }),
  asset(42, 'FC1/BLOWER1', 'fc.blower', { parentId: 40 }),
];
const byId = (id: number): PipelineAsset => SITE.find((a) => a.id === id) as PipelineAsset;

describe('seriesRequests', () => {
  it('설비 종류별로 자신·상위·형제·사이트 기상 설비 메트릭을 한 맵으로 요청한다', () => {
    expect(seriesRequests(byId(7), SITE).map((r) => r.metricKey)).toEqual(['batt.current', 'batt.voltage', 'batt.soc', 'cell.temp.avg', 'cell.voltage.max', 'cell.voltage.min']);
    expect(seriesRequests(byId(101), SITE)).toContainEqual({ assetId: 20, metricKey: 'poa.irradiance' });
    expect(seriesRequests(byId(31), SITE)).toContainEqual({ assetId: 30, metricKey: 'h2.flow.mass' });
    const fc = seriesRequests(byId(41), SITE);
    expect(fc).toContainEqual({ assetId: 40, metricKey: 'fc.h2.consumption' });
    expect(fc).toContainEqual({ assetId: 42, metricKey: 'blower.power' });
  });

  it('추출 대상이 아니면 빈 배열, 관련 설비가 없으면 그 메트릭만 뺀다', () => {
    expect(seriesRequests(byId(1), SITE)).toEqual([]);
    const withoutWeather = SITE.filter((a) => a.classKey !== 'wx.station');
    expect(seriesRequests(byId(101), withoutWeather).map((r) => r.metricKey)).toEqual(['ac.power', 'ac.power.limit', 'op.state']);
  });
});

describe('extractAssetEpisodes', () => {
  it('명판 숫자를 검증하고 랙 원시 → ess 에피소드를 만든다', () => {
    expect(nameplateNumber(asset(1, 'X', 'ess.rack', { nameplate: { capacity_ah: '600' } }), 'capacity_ah')).toBe(600);
    expect(() => nameplateNumber(byId(1), 'capacity_ah')).toThrow(NameplateError);
    const series = essChargeCycle({ start: T0 + 60 * MS_PER_MINUTE, restBeforeMin: 90, chargeA: 50, ccHours: 7, taperMin: 15, restAfterMin: 60, socStartPct: 5 });
    const episodes = extractAssetEpisodes(byId(7), series, { start: T0, end: T0 + MS_PER_DAY });
    expect(episodes.map((e) => e.kind)).toEqual(['ess.charge', 'ess.rest', 'ess.rest']);
    expect(extractAssetEpisodes(byId(1), series, { start: T0, end: T0 + MS_PER_DAY })).toEqual([]);
    expect(() => extractAssetEpisodes(asset(99, 'PV1/INV09', 'pv.inverter'), {}, { start: T0, end: T0 + MS_PER_DAY })).toThrow('ac_kw');
  });
});

describe('resolveDetectorConfig', () => {
  const window = { start: DAY0, end: DAY0 + 10 * MS_PER_DAY };
  const configs: DetectorConfigRow[] = [
    { detectorId: 'ess.capacity_fade', scope: 'asset:7', version: 3, params: { minTotal: 12, bogus: 1 }, referenceWindow: window },
    { detectorId: 'ess.capacity_fade', scope: 'default', version: 1, params: { minTotal: 20, recentDays: 14, referenceCurrentA: 50 }, referenceWindow: null },
    { detectorId: 'ess.capacity_fade', scope: 'class:ess.rack', version: 2, params: { recentDays: 'x', sev2Pct: -4 }, referenceWindow: null },
    { detectorId: 'el.voltage_rise', scope: 'default', version: 1, params: { minTotal: 1 }, referenceWindow: null },
  ];
  const defaults = { minTotal: 15, recentDays: 21, sev2Pct: -3, referenceCurrentA: null as number | null };

  it('default < class < asset 순으로 병합하고, 모르는 키·틀린 타입은 버린다', () => {
    const resolved = resolveDetectorConfig(configs, 'ess.capacity_fade', { id: 7, classKey: 'ess.rack' }, defaults);
    expect(resolved.params).toEqual({ minTotal: 12, recentDays: 14, sev2Pct: -4, referenceCurrentA: 50 });
    expect(resolved.referenceWindow).toEqual(window);
    expect(resolved.versions).toEqual(['default@1', 'class:ess.rack@2', 'asset:7@3']);
    expect(resolved.rejectedKeys).toEqual(['class:ess.rack.recentDays', 'asset:7.bogus']);
  });

  it('동종 그룹 실행(id null)은 asset 범위를 쓰지 않고, 대상 없음은 default만', () => {
    expect(resolveDetectorConfig(configs, 'ess.capacity_fade', { id: null, classKey: 'ess.rack' }, defaults).versions).toEqual(['default@1', 'class:ess.rack@2']);
    expect(resolveDetectorConfig(configs, 'ess.capacity_fade', null, defaults).params).toEqual({ minTotal: 20, recentDays: 14, referenceCurrentA: 50 });
  });
});

const NOW = DAY0 + 90 * MS_PER_DAY;
const withAsset = <E extends StoredEpisode>(episodes: readonly E[], assetId: number): E[] => episodes.map((e) => ({ ...e, assetId }));

function snapshot(extra: Partial<SiteSnapshot> = {}): SiteSnapshot {
  const racks = [...withAsset(capacityHistory(400, 370, 21), 7), ...withAsset(capacityHistory(400, 400, 22), 8), ...withAsset(capacityHistory(400, 400, 23), 9)];
  const pv = Array.from({ length: 8 }, (_, day) => [1, 2, 3, 4].map((i) => pvDay(i + 100, day + 82, i === 4 ? 3.6 : 4 * (1 + 0.001 * i)))).flat();
  return { siteId: 1, assets: SITE, episodes: [...racks, ...pv, ...withAsset(elRuns({ count: 200, startHours: 1200, endHours: 2400, rateUvPerH: 40, seed: 3 }), 31)], events: [], configs: [], ...extra };
}

describe('indexSnapshot', () => {
  it('설비와 상위 설비 이벤트를 모으고 now 이전 마지막 기준선 재설정을 찾는다', () => {
    const index = indexSnapshot(snapshot({
      events: [
        { assetId: 1, ts: DAY0 + 30 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: true, note: 'SOC 상한' },
        { assetId: 7, ts: DAY0 + 10 * MS_PER_DAY, kind: 'maintenance', resetsBaseline: false },
        { assetId: 7, ts: NOW + MS_PER_DAY, kind: 'replacement', resetsBaseline: true },
      ],
    }));
    expect(index.eventsFor(7).map((e) => e.kind)).toEqual(['maintenance', 'setpoint_change', 'replacement']);
    expect(index.eventsFor(8).map((e) => e.kind)).toEqual(['setpoint_change']);
    expect(index.baselineResetAt(7, NOW)).toBe(DAY0 + 30 * MS_PER_DAY);
    expect(index.baselineResetAt(20, NOW)).toBeUndefined();
    expect(index.episodesOf(7, 'ess.charge')).toHaveLength(90);
    expect(index.episodesOf(7, 'ess.rest')).toEqual([]);
  });
});

describe('runSiteDetectors', () => {
  it('설비별 입력을 조립해 용량 감소 랙·저성능 인버터·전해조 열화만 finding으로 낸다', () => {
    const outcomes = runSiteDetectors(snapshot(), { now: NOW, seed: 5 });
    const findings = outcomes.flatMap((o) => o.findings.map((f) => [f.detectorId, f.assetId]));
    expect(findings).toEqual([
      ['ess.capacity_fade', 7],
      ['pv.inverter_peer', 104],
      ['el.voltage_rise', 31],
    ]);
    expect(outcomes.filter((o) => o.detectorId === 'ess.capacity_fade').map((o) => o.assetId)).toEqual([7, 8, 9]);
    expect(outcomes.find((o) => o.detectorId === 'fc.voltage_decay')).toMatchObject({ status: 'insufficient', assetId: 41 });
    expect(outcomes.some((o) => o.detectorId === 'dq.gap_flatline')).toBe(false);
    expect(runSiteDetectors(snapshot(), { now: NOW, seed: 5 })).toEqual(outcomes);
  });

  it('대상 설비만 결과를 남기고 설정·기준선 재설정을 반영한다', () => {
    const targeted = runSiteDetectors(snapshot(), { now: NOW, seed: 5, targetAssetIds: new Set([8, 103]), detectorIds: ['ess.capacity_fade', 'pv.inverter_peer'] });
    expect(targeted.map((o) => [o.detectorId, o.assetId, o.findings.length])).toEqual([
      ['ess.capacity_fade', 8, 0],
      ['pv.inverter_peer', null, 0],
    ]);
    const config: DetectorConfigRow = { detectorId: 'ess.capacity_fade', scope: 'asset:7', version: 2, params: { sev2Pct: -50, sev3Pct: -60, sev4Pct: -70 }, referenceWindow: null };
    const tuned = runSiteDetectors(snapshot({ configs: [config] }), { now: NOW, seed: 5, targetAssetIds: new Set([7]), detectorIds: ['ess.capacity_fade'] });
    expect(tuned[0]).toMatchObject({ status: 'ok', findings: [], configVersions: ['asset:7@2'] });
    const reset = runSiteDetectors(snapshot({ events: [{ assetId: 1, ts: NOW - 5 * MS_PER_DAY, kind: 'setpoint_change', resetsBaseline: true }] }), { now: NOW, seed: 5, detectorIds: ['ess.capacity_fade'] });
    expect(reset.map((o) => o.status)).toEqual(['insufficient', 'insufficient', 'insufficient']);
  });

  it('셀 불균형은 동종 랙 최근 편차를, dq는 스냅샷 요약을 쓰고, 탐지기 예외는 error 결과가 된다', () => {
    const cell = runSiteDetectors(snapshot(), { now: NOW, seed: 5, detectorIds: ['ess.cell_imbalance'] });
    expect(cell.map((o) => o.status)).toEqual(['ok', 'ok', 'ok']);
    const dq = { siteId: 1, window: { start: NOW - 7 * MS_PER_DAY, end: NOW }, points: [{ pointId: 1, assetId: 7, metricKey: 'batt.soc', sourceKey: 'ESS1/RACK01/SOC', expectedSamples: 100, receivedSamples: 50, gaps: [{ start: NOW - 3 * MS_PER_HOUR, end: NOW }], flatlines: [] }] };
    expect(runSiteDetectors(snapshot({ dq }), { now: NOW, seed: 5, detectorIds: ['dq.gap_flatline'] })[0]?.findings.map((f) => f.assetId)).toEqual([7]);
    const broken = { ...elRuns({ count: 1, startHours: 1200, endHours: 1300, rateUvPerH: 0, seed: 1 })[0], assetId: 31, features: null } as unknown as StoredEpisode;
    const errored = runSiteDetectors(snapshot({ episodes: [broken] }), { now: NOW, seed: 5, detectorIds: ['el.voltage_rise'] });
    expect(errored[0]).toMatchObject({ status: 'error', findings: [] });
    expect(errored[0]?.reason).toBeTruthy();
  });
});
