// 일 KPI 행 조립 (순수): 에피소드·1시간 롤업 → om.kpi_daily 행. 계산 식은 kpi/daily.ts가 정한다.
//   인버터: pv.kwh(m_1h ac.power) · pv.specific_yield_kwh_kwp · pv.inverter_peer_ratio · availability(pv.day)
//   사이트: pv.kwh 합계 · pv.specific_yield_kwh_kwp
//   랙: ess.rte (충전·방전 에피소드 Wh + m_1h batt.soc 첫·끝값)
//   전해조 스택: elz.sec_kwh_per_kg · elz.v_cell_ref / 연료전지 스택: fc.kg_per_mwh · fc.v_cell_ref
import type { EssChargeEpisode, EssDischargeEpisode } from '../episodes/ess';
import type { PvDayEpisode } from '../episodes/pv';
import type { ElSteadyEpisode, FcSteadyEpisode } from '../episodes/stack-episodes';
import { elzSec, elzVCellRef, essRte, fcKgPerMwh, fcVCellRef, inverterPeerRatios, pvDayAvailability, pvKwh, specificYield, type HourlyRow, type KpiValue } from '../kpi/daily';
import { kstDateString, kstDayStart, MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '../types';
import type { PipelineAsset, StoredEpisode } from './types';

/** om.m_1h 한 행 + 어느 설비·메트릭인지 */
export interface HourlyPointRow extends HourlyRow {
  readonly assetId: number;
  readonly metricKey: string;
  readonly periodS: number;
  readonly first: number | null;
  readonly last: number | null;
}

export interface KpiRow {
  readonly scopeType: 'site' | 'asset';
  readonly scopeId: number;
  /** KST 'YYYY-MM-DD' */
  readonly day: string;
  readonly kpi: KpiValue;
}

export interface KpiInput {
  readonly siteId: number;
  readonly assets: readonly PipelineAsset[];
  readonly episodes: readonly StoredEpisode[];
  readonly hourly: readonly HourlyPointRow[];
  readonly window: TimeWindow;
}

const num = (asset: PipelineAsset, key: string): number => {
  const value = Number(asset.nameplate[key]);
  return Number.isFinite(value) ? value : 0;
};

function kstDays(window: TimeWindow): number[] {
  const first = kstDayStart(window.start);
  return Array.from({ length: Math.max(0, Math.ceil((window.end - first) / MS_PER_DAY)) }, (_, i) => first + i * MS_PER_DAY);
}

const inDay = (ts: number, day: number): boolean => ts >= day && ts < day + MS_PER_DAY;
const hasInput = (kpi: KpiValue): boolean => kpi.n > 0 || kpi.value !== null;
const assetRow = (asset: PipelineAsset, day: number, kpi: KpiValue): KpiRow => ({ scopeType: 'asset', scopeId: asset.id, day: kstDateString(day), kpi });

function inverterRows(input: KpiInput, day: number): KpiRow[] {
  const inverters = input.assets.filter((a) => a.classKey === 'pv.inverter');
  const energies = inverters.map((inv) => {
    const rows = input.hourly.filter((h) => h.assetId === inv.id && h.metricKey === 'ac.power' && inDay(h.hourStart, day));
    const periodS = rows[0]?.periodS ?? 60;
    return { inv, energy: pvKwh(rows, MS_PER_HOUR / 1000 / periodS) };
  });
  const ratios = inverterPeerRatios(energies.map(({ inv, energy }) => ({ assetId: inv.id, kwh: energy.value, dcKwp: num(inv, 'dc_kwp') })));
  const perInverter = energies.flatMap(({ inv, energy }) => {
    const pvDay = input.episodes.find((e): e is PvDayEpisode => e.kind === 'pv.day' && e.assetId === inv.id && e.start === day);
    const ratio = ratios.get(inv.id);
    return [energy, specificYield(energy, num(inv, 'dc_kwp')), ...(ratio ? [ratio] : []), ...(pvDay?.valid ? [pvDayAvailability(pvDay)] : [])].filter(hasInput).map((kpi) => assetRow(inv, day, kpi));
  });
  const withEnergy = energies.filter(({ energy }) => energy.value !== null);
  const first = withEnergy[0];
  if (!first) return perInverter;
  const total = withEnergy.reduce((sum, { energy }) => sum + (energy.value ?? 0), 0);
  const siteEnergy: KpiValue = { ...first.energy, value: total, n: withEnergy.reduce((sum, e) => sum + e.energy.n, 0), dqCompleteness: withEnergy.reduce((sum, e) => sum + (e.energy.dqCompleteness ?? 0), 0) / withEnergy.length };
  const siteKwp = withEnergy.reduce((sum, { inv }) => sum + num(inv, 'dc_kwp'), 0);
  const site = (kpi: KpiValue): KpiRow => ({ scopeType: 'site', scopeId: input.siteId, day: kstDateString(day), kpi });
  return [...perInverter, site(siteEnergy), site(specificYield(siteEnergy, siteKwp))];
}

function rackRows(input: KpiInput, day: number): KpiRow[] {
  return input.assets
    .filter((a) => a.classKey === 'ess.rack')
    .flatMap((rack) => {
      const charges = input.episodes.filter((e): e is EssChargeEpisode => e.kind === 'ess.charge' && e.assetId === rack.id && e.valid && inDay(e.start, day));
      const discharges = input.episodes.filter((e): e is EssDischargeEpisode => e.kind === 'ess.discharge' && e.assetId === rack.id && e.valid && inDay(e.start, day));
      const soc = input.hourly.filter((h) => h.assetId === rack.id && h.metricKey === 'batt.soc' && inDay(h.hourStart, day)).sort((a, b) => a.hourStart - b.hourStart);
      if (charges.length === 0 && discharges.length === 0) return [];
      const completeness = [...charges, ...discharges].map((e) => e.dq.completeness);
      const rte = essRte({
        chargeKwh: charges.reduce((sum, e) => sum + (e.features.wh_in ?? 0), 0) / 1000,
        dischargeKwh: discharges.reduce((sum, e) => sum + (e.features.wh_out ?? 0), 0) / 1000,
        socStartPct: soc[0]?.first ?? null,
        socEndPct: soc.at(-1)?.last ?? null,
        usableKwh: num(rack, 'energy_kwh'),
        dqCompleteness: completeness.reduce((sum, c) => sum + c, 0) / completeness.length,
      });
      return [assetRow(rack, day, rte)];
    });
}

function stackRows(input: KpiInput, day: number): KpiRow[] {
  return input.assets.flatMap((stack) => {
    if (stack.classKey === 'h2.elz.stack') {
      const runs = input.episodes.filter((e): e is ElSteadyEpisode => e.kind === 'el.steady_run' && e.assetId === stack.id && inDay(e.start, day));
      const jRated = num(stack, 'rated_current_a') / Math.max(1, num(stack, 'active_area_cm2'));
      return [elzSec(runs), elzVCellRef(runs, { jRefAcm2: 0.9 * jRated, jToleranceAcm2: 0.1 * jRated })].filter(hasInput).map((kpi) => assetRow(stack, day, kpi));
    }
    if (stack.classKey === 'fc.stack') {
      const runs = input.episodes.filter((e): e is FcSteadyEpisode => e.kind === 'fc.steady_run' && e.assetId === stack.id && inDay(e.start, day));
      return [fcKgPerMwh(runs), fcVCellRef(runs)].filter(hasInput).map((kpi) => assetRow(stack, day, kpi));
    }
    return [];
  });
}

/** 창에 걸친 KST 날짜마다 KPI 행. 입력이 전혀 없는 KPI는 행을 만들지 않는다 */
export function dailyKpiRows(input: KpiInput): KpiRow[] {
  return kstDays(input.window).flatMap((day) => [...inverterRows(input, day), ...rackRows(input, day), ...stackRows(input, day)]);
}
