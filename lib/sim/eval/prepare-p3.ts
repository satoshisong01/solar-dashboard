// 평가 잡 준비 (P3): 에피소드가 아닌 탐지기 입력을 메모리 시계열에서 DB 경로와 같은 순수 함수로 만든다 (JSON으로 캐시할 수 있게 배열로 둔다).
//   정지 보유 구간 원시 P·T(tankHoldPoints) · 인버터 열 저감 5분 버킷 표본 · 정류기 효율 일 중앙값(1시간 롤업) · 체인 원장 일 행(1시간 롤업 → buildLedgerDays)
// DB 경로는 정지 구간·열 저감 원시를 필요한 구간만 읽는다(lib/analysis). 여기서는 전체를 만들고 점검 시각마다 같은 규칙의 창으로 자른다.
import type { TimedNumber } from '@/lib/analytics/detectors/common';
import { INV_THERMAL_DERATING_DEFAULTS } from '@/lib/analytics/detectors/inv-thermal-derating';
import { inverterThermalSamples, type InverterThermalSample } from '@/lib/analytics/episodes/inverter-thermal';
import { tankHoldPointsMany, type TankHoldPoint } from '@/lib/analytics/episodes/tank-hold';
import { LEDGER_METRICS } from '@/lib/analytics/ledger/hourly';
import { rectifierEfficiencyDays, thermalSampleWindow } from '@/lib/analytics/pipeline/load-plans';
import { buildLedgerDays, completeKstDays, ledgerDayRowOf, type LedgerDayRow } from '@/lib/analytics/pipeline/site-ledger';
import type { SiteAuxInputs } from '@/lib/analytics/pipeline/snapshot';
import type { PipelineAsset, StoredEpisode } from '@/lib/analytics/pipeline/types';
import type { TimeWindow } from '@/lib/analytics/types';
import { pointKey, type MemorySeries } from '../memory';
import type { EvalSite } from './assets';
import { hourlyRows } from './hourly';
import { assetSeriesFor } from './memory-series';

export interface PreparedP3 {
  /** 저장용기 id → [정지 구간 시작, 압력·온도 짝] */
  readonly tankHoldPoints: readonly (readonly [assetId: number, holds: readonly (readonly [start: number, points: readonly TankHoldPoint[]])[]])[];
  /** ts 오름차순 */
  readonly thermalSamples: readonly InverterThermalSample[];
  readonly rectifierEfficiency: readonly (readonly [stackId: number, days: readonly TimedNumber[]])[];
  readonly ledgerDays: readonly LedgerDayRow[];
}

type Memory = ReadonlyMap<string, MemorySeries>;

const seriesOf = (site: EvalSite, memory: Memory, asset: PipelineAsset, metricKey: string) => memory.get(pointKey(`${site.site.code}/${asset.code}`, metricKey));

function tankPoints(site: EvalSite, memory: Memory, episodes: readonly StoredEpisode[]): PreparedP3['tankHoldPoints'] {
  const assetById = new Map(site.assets.map((a) => [a.id, a]));
  return site.assets
    .filter((a) => a.classKey === 'h2.storage.tank')
    .map((tank) => {
      const series = assetSeriesFor(['tank.pressure', 'tank.temp'].map((metricKey) => ({ assetId: tank.id, metricKey })), assetById, site.site.code, memory);
      const holds = episodes.filter((e) => e.kind === 'tank.hold' && e.assetId === tank.id && e.valid);
      const points = tankHoldPointsMany(series, holds);
      return [tank.id, holds.map((hold, i) => [hold.start, points[i] ?? []] as const)] as const;
    });
}

function thermal(site: EvalSite, memory: Memory, window: TimeWindow): InverterThermalSample[] {
  const assetById = new Map(site.assets.map((a) => [a.id, a]));
  const inverters = site.assets.filter((a) => a.classKey === 'pv.inverter');
  const station = site.assets.find((a) => a.classKey === 'wx.station');
  if (inverters.length === 0) return [];
  const sources = inverters.map((inv) => ({ assetId: inv.id, dcKwp: Number(inv.nameplate.dc_kwp) || 0, series: assetSeriesFor(['ac.power', 'heatsink.temp', 'ac.power.limit'].map((metricKey) => ({ assetId: inv.id, metricKey })), assetById, site.site.code, memory) }));
  const ambient = station ? assetSeriesFor([{ assetId: station.id, metricKey: 'ambient.temp' }], assetById, site.site.code, memory) : {};
  return inverterThermalSamples(sources, ambient, window);
}

function rectifier(site: EvalSite, memory: Memory): PreparedP3['rectifierEfficiency'] {
  return site.assets
    .filter((a) => a.classKey === 'h2.elz.stack')
    .flatMap((stack) => {
      const unit = site.assets.find((a) => a.classKey === 'h2.elz.rectifier' && a.parentId === stack.parentId);
      const series = unit ? seriesOf(site, memory, unit, 'rectifier.efficiency') : undefined;
      return unit && series ? [[stack.id, rectifierEfficiencyDays(hourlyRows(series, unit.id, 'rectifier.efficiency'))] as const] : [];
    });
}

function ledger(site: EvalSite, memory: Memory, window: TimeWindow): LedgerDayRow[] {
  if (!site.assets.some((a) => a.classKey === 'h2.elz' || a.classKey === 'fc.plant')) return [];
  const rows = site.assets.flatMap((asset) => [...LEDGER_METRICS].flatMap((metricKey) => {
    const series = seriesOf(site, memory, asset, metricKey);
    return series ? hourlyRows(series, asset.id, metricKey) : [];
  }));
  const assets = site.assets.map((a) => ({ id: a.id, code: a.code, classKey: a.classKey, nameplate: a.nameplate }));
  return buildLedgerDays({ assets, rows, dayStarts: completeKstDays(window), prRef: null }).map(ledgerDayRowOf);
}

export function prepareP3(site: EvalSite, memory: Memory, window: TimeWindow, episodes: readonly StoredEpisode[]): PreparedP3 {
  return { tankHoldPoints: tankPoints(site, memory, episodes), thermalSamples: thermal(site, memory, window), rectifierEfficiency: rectifier(site, memory), ledgerDays: ledger(site, memory, window) };
}

/** 첫 표본 인덱스 (ts 오름차순 이진 탐색) */
function lowerBound(samples: readonly InverterThermalSample[], ts: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid] as InverterThermalSample).ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 점검 시각 now의 보조 입력: 열 저감 표본은 DB 경로와 같은 창(thermalSampleWindow)으로 자른다 */
export function auxAt(prepared: PreparedP3, now: number): SiteAuxInputs {
  const window = thermalSampleWindow(now, INV_THERMAL_DERATING_DEFAULTS.recentDays);
  return {
    tankHoldPoints: new Map(prepared.tankHoldPoints.map(([id, holds]) => [id, new Map(holds)])),
    thermalSamples: prepared.thermalSamples.slice(lowerBound(prepared.thermalSamples, window.start), lowerBound(prepared.thermalSamples, window.end)),
    rectifierEfficiency: new Map(prepared.rectifierEfficiency),
    ledgerDays: prepared.ledgerDays,
  };
}
