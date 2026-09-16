// P3 탐지기의 에피소드가 아닌 입력 조회 (load 계층). 판단은 lib/analytics가 한다.
//   inv.thermal_derating  최근 recentDays + 기준 60일 원시 → 5분 버킷 표본, 인버터 event_log 코드
//   el.sec_rise           형제 정류기 rectifier.efficiency 1시간 롤업 → 일 중앙값, 전해조 purge.count 누적 카운터 → 일 증가분
//   pv.soiling_rate       세척 조치(maintenance_action), 최근 SMP(market_daily smp_land)
//   prv.seat_leak · hx.fouling · o2.purity_drift  1시간 롤업 → 무유동 hold 구간 · 정상상태 표본 · 운전일 HTO (gapyeong-samples)
import { sql, type Kysely } from 'kysely';
import { invThermalDerating } from '@/lib/analytics/detectors/inv-thermal-derating';
import type { TimedNumber } from '@/lib/analytics/detectors/common';
import { htoDays, hxSamples, prvHolds, type HourRowLike } from '@/lib/analytics/episodes/gapyeong-samples';
import { inverterThermalSamples, type InverterThermalSample } from '@/lib/analytics/episodes/inverter-thermal';
import { resolveDetectorConfig } from '@/lib/analytics/pipeline/config';
import { counterDailyDeltas, rectifierEfficiencyDays, thermalSampleWindow } from '@/lib/analytics/pipeline/load-plans';
import type { SiteAuxInputs } from '@/lib/analytics/pipeline/snapshot';
import type { DetectorConfigRow, PipelineAsset } from '@/lib/analytics/pipeline/types';
import type { DB } from '@/lib/db/types';
import type { PointRow } from './catalog';
import { loadAssetSeries, loadHourly } from './series';

const nameplateNumber = (asset: PipelineAsset, key: string): number => {
  const value = Number(asset.nameplate[key]);
  return Number.isFinite(value) ? value : 0;
};

async function thermalInputs(db: Kysely<DB>, assets: readonly PipelineAsset[], points: readonly PointRow[], configs: readonly DetectorConfigRow[], now: number): Promise<Pick<SiteAuxInputs, 'thermalSamples' | 'inverterFaultEvents'>> {
  const inverters = assets.filter((a) => a.classKey === 'pv.inverter');
  const station = assets.filter((a) => a.classKey === 'wx.station').sort((a, b) => (a.code < b.code ? -1 : 1))[0];
  if (inverters.length === 0) return {};
  const config = resolveDetectorConfig(configs, invThermalDerating.id, { id: null, classKey: 'pv.inverter' }, invThermalDerating);
  const window = thermalSampleWindow(now, config.ok ? config.params.recentDays : invThermalDerating.defaultParams.recentDays);
  const sources: { assetId: number; dcKwp: number; series: Awaited<ReturnType<typeof loadAssetSeries>> }[] = []; // 인버터마다 읽은 원시를 모으는 누적 목록
  for (const inv of inverters) {
    const series = await loadAssetSeries(db, ['ac.power', 'heatsink.temp', 'ac.power.limit'].map((metricKey) => ({ assetId: inv.id, metricKey })), points, { start: window.start - 15 * 60_000, end: window.end });
    sources.push({ assetId: inv.id, dcKwp: nameplateNumber(inv, 'dc_kwp'), series });
  }
  const ambient = station ? await loadAssetSeries(db, [{ assetId: station.id, metricKey: 'ambient.temp' }], points, { start: window.start - 15 * 60_000, end: window.end }) : {};
  const events = await db
    .selectFrom('om.event_log')
    .select(['asset_id', 'ts', 'code'])
    .where('asset_id', 'in', inverters.map((a) => a.id))
    .where('ts', '>=', new Date(window.start))
    .where('ts', '<', new Date(window.end))
    .execute();
  const samples: InverterThermalSample[] = inverterThermalSamples(sources, ambient, window);
  return { thermalSamples: samples, inverterFaultEvents: events.map((e) => ({ assetId: e.asset_id ?? 0, ts: e.ts.getTime(), code: e.code })) };
}

async function rectifierInputs(db: Kysely<DB>, assets: readonly PipelineAsset[], points: readonly PointRow[], now: number): Promise<Map<number, TimedNumber[]>> {
  const result = new Map<number, TimedNumber[]>();
  for (const stack of assets.filter((a) => a.classKey === 'h2.elz.stack')) {
    const rectifier = assets.find((a) => a.classKey === 'h2.elz.rectifier' && a.parentId === stack.parentId);
    const point = rectifier ? points.filter((p) => p.assetId === rectifier.id && p.metricKey === 'rectifier.efficiency') : [];
    if (point.length === 0) continue;
    result.set(stack.id, rectifierEfficiencyDays(await loadHourly(db, point, { start: 0, end: now })));
  }
  return result;
}

/** 전해조 스택 id → 일 퍼지 횟수 증가분. 퍼지 카운터는 스택이나 상위 전해조 설비(h2.elz)에 붙는다 */
async function purgeInputs(db: Kysely<DB>, assets: readonly PipelineAsset[], points: readonly PointRow[], now: number): Promise<Map<number, TimedNumber[]>> {
  const result = new Map<number, TimedNumber[]>();
  for (const stack of assets.filter((a) => a.classKey === 'h2.elz.stack')) {
    const owners = new Set([stack.id, ...(stack.parentId === null ? [] : [stack.parentId])]);
    const purgePoints = points.filter((p) => owners.has(p.assetId) && p.metricKey === 'purge.count');
    if (purgePoints.length === 0) continue;
    result.set(stack.id, counterDailyDeltas(await loadHourly(db, purgePoints, { start: 0, end: now })));
  }
  return result;
}

async function pvInputs(db: Kysely<DB>, siteId: number, assets: readonly PipelineAsset[], now: number): Promise<Pick<SiteAuxInputs, 'cleaningTs' | 'smpKrwPerKwh'>> {
  const pvIds = assets.filter((a) => a.classKey === 'pv.plant' || a.classKey === 'pv.inverter').map((a) => a.id);
  if (pvIds.length === 0) return {};
  const { rows } = await sql<{ performed_ms: number }>`
    SELECT (extract(epoch FROM performed_at) * 1000)::float8 AS performed_ms FROM om.maintenance_action
    WHERE site_id = ${siteId} AND asset_id = ANY(${pvIds}::int4[]) AND performed_at < ${new Date(now).toISOString()}::timestamptz
      AND (action_type ~* '(세척|clean)' OR coalesce(notes, '') ~* '(세척|clean)')
  `.execute(db);
  const smp = await db.selectFrom('om.market_daily').select('value').where('market_key', '=', 'smp_land').where('day', '<=', new Date(now)).orderBy('day', 'desc').executeTakeFirst();
  return { cleaningTs: rows.map((r) => r.performed_ms), smpKrwPerKwh: smp ? Number(smp.value) : null };
}

/** 무유동 hold 판정 기준 [kg/h] — tank.hold 정지 판정과 같은 값 */
const IDLE_MAX_KG_H = 0.05;
/** 'h2.pressure#fc.inlet' → 'h2.pressure' */
const baseMetricKey = (key: string): string => key.split('#')[0] ?? key;
/** 전해조 운전 판정 기준 [kg/h] */
const ELZ_RUNNING_MIN_KG_H = 0.05;

/** 가평 구성 탐지기 3종 보조 입력. 해당 설비가 없는 사이트는 빈 맵이다 */
async function gapyeongInputs(db: Kysely<DB>, assets: readonly PipelineAsset[], points: readonly PointRow[], now: number): Promise<Pick<SiteAuxInputs, 'prvHolds' | 'hxSamples' | 'htoDays'>> {
  const prvs = assets.filter((a) => a.classKey === 'h2.prv');
  const hxs = assets.filter((a) => a.classKey === 'hx.recovery');
  const o2s = assets.filter((a) => a.classKey === 'o2.plant');
  if (prvs.length === 0 && hxs.length === 0 && o2s.length === 0) return {};
  const window = { start: 0, end: now };
  /**
   * loadSitePoints는 한정자가 있는 포인트를 'metric#qualifier'로 준다. 표본 조립기(gapyeong-samples)는 한정자 없는 기본 키로 찾으므로
   * 여기서 기본 키로 고르고 행의 metricKey도 기본 키로 되돌린다. 아래 메트릭은 설비마다 한정자가 하나뿐이라 겹치지 않는다.
   */
  const load = async (metricKeys: readonly string[], assetIds: readonly number[], include: (p: PointRow) => boolean = () => true): Promise<HourRowLike[]> => {
    const selected = points.filter((p) => assetIds.includes(p.assetId) && metricKeys.includes(baseMetricKey(p.metricKey)) && include(p));
    if (selected.length === 0) return [];
    const rows = await loadHourly(db, selected, window);
    return rows.map((row) => ({ ...row, metricKey: baseMetricKey(row.metricKey) }));
  };

  const fcPlants = assets.filter((a) => a.classKey === 'fc.plant');
  const banks = assets.filter((a) => a.classKey === 'h2.storage.bank');
  const stations = assets.filter((a) => a.classKey === 'wx.station');
  const elz = assets.find((a) => a.classKey === 'h2.elz') ?? null;
  const stacks = assets.filter((a) => a.classKey === 'h2.elz.stack');

  // 감압밸브 하류 압력은 스키드(PRV1)에 계기가 있으면 그걸 쓰고, 도면처럼 연료전지 입구에 붙어 있으면 한정자 fc.inlet 포인트만 쓴다
  const prvIds = new Set(prvs.map((a) => a.id));
  const isOutletPressure = (p: PointRow) => baseMetricKey(p.metricKey) !== 'h2.pressure' || prvIds.has(p.assetId) || p.metricKey === 'h2.pressure#fc.inlet';
  const prvRows = prvs.length === 0 ? [] : await load(['h2.pressure', 'h2.pressure.setpoint', 'fc.h2.consumption', 'ambient.temp'], [...prvs, ...fcPlants, ...banks, ...stations].map((a) => a.id), isOutletPressure);
  const hxRows = hxs.length === 0 ? [] : await load(['hx.temp.hot.in', 'hx.temp.hot.out', 'hx.temp.cold.in', 'hx.temp.cold.out', 'hx.flow.cold', 'hx.flow.hot', 'hx.heat.recovered', 'hx.pressure.diff.hot'], hxs.map((a) => a.id));
  const o2Rows = o2s.length === 0 ? [] : await load(['h2.in.o2', 'h2.flow.mass', 'stack.current'], [...o2s, ...(elz === null ? [] : [elz]), ...stacks].map((a) => a.id));

  return {
    prvHolds: new Map(prvs.map((prv) => [prv.id, prvHolds(prvRows, { prvAssetId: prv.id, outletAssetIds: [prv.id, ...fcPlants.map((a) => a.id)], fcAssetIds: fcPlants.map((a) => a.id), bufferAssetIds: banks.map((a) => a.id), wxAssetId: stations[0]?.id ?? null, idleMaxKgH: IDLE_MAX_KG_H })])),
    hxSamples: new Map(hxs.map((hx) => [hx.id, hxSamples(hxRows, hx.id)])),
    htoDays: new Map(
      o2s.map((plant) => [
        plant.id,
        htoDays(o2Rows, { htoAssetId: plant.id, elzAssetId: elz?.id ?? null, elzStackAssetIds: stacks.map((a) => a.id), ratedCurrentA: stacks[0] ? nameplateNumber(stacks[0], 'rated_current_a') || null : null, runningMinKgH: ELZ_RUNNING_MIN_KG_H }),
      ]),
    ),
  };
}

/** 사이트 P3 보조 입력 (정지 구간 원시 점·원장 일 행은 따로 채운다) */
export async function loadAuxInputs(db: Kysely<DB>, siteId: number, assets: readonly PipelineAsset[], points: readonly PointRow[], configs: readonly DetectorConfigRow[], now: number): Promise<SiteAuxInputs> {
  const [thermal, rectifierEfficiency, purgeCounts, pv, gapyeong] = [
    await thermalInputs(db, assets, points, configs, now),
    await rectifierInputs(db, assets, points, now),
    await purgeInputs(db, assets, points, now),
    await pvInputs(db, siteId, assets, now),
    await gapyeongInputs(db, assets, points, now),
  ];
  return { ...thermal, rectifierEfficiency, purgeCounts, ...pv, ...gapyeong };
}
