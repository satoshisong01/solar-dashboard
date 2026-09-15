// P3 탐지기의 에피소드가 아닌 입력 조회 (load 계층). 판단은 lib/analytics가 한다.
//   inv.thermal_derating  최근 recentDays + 기준 60일 원시 → 5분 버킷 표본, 인버터 event_log 코드
//   el.sec_rise           형제 정류기 rectifier.efficiency 1시간 롤업 → 일 중앙값
//   pv.soiling_rate       세척 조치(maintenance_action), 최근 SMP(market_daily smp_land)
import { sql, type Kysely } from 'kysely';
import { invThermalDerating } from '@/lib/analytics/detectors/inv-thermal-derating';
import type { TimedNumber } from '@/lib/analytics/detectors/common';
import { inverterThermalSamples, type InverterThermalSample } from '@/lib/analytics/episodes/inverter-thermal';
import { resolveDetectorConfig } from '@/lib/analytics/pipeline/config';
import { rectifierEfficiencyDays, thermalSampleWindow } from '@/lib/analytics/pipeline/load-plans';
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

/** 사이트 P3 보조 입력 (정지 구간 원시 점·원장 일 행은 따로 채운다) */
export async function loadAuxInputs(db: Kysely<DB>, siteId: number, assets: readonly PipelineAsset[], points: readonly PointRow[], configs: readonly DetectorConfigRow[], now: number): Promise<SiteAuxInputs> {
  const [thermal, rectifierEfficiency, pv] = [await thermalInputs(db, assets, points, configs, now), await rectifierInputs(db, assets, points, now), await pvInputs(db, siteId, assets, now)];
  return { ...thermal, rectifierEfficiency, ...pv };
}
