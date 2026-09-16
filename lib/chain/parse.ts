// om.site_energy_daily 행(jsonb) → SiteEnergyDay (순수). 분석 실행(lib/analysis/ledger.ts)이 쓴 형식을 읽되,
// 모르는 값·빠진 값은 null(비율·KPI·수소 원장) 또는 0(에너지 합계)으로 두어 화면이 깨지지 않게 한다. 흐름 노드 이름이 틀린 항목은 버린다.
import { ALLOC_VERSION, DEMAND_NODES, SUPPLY_NODES, UNMETERED, type DemandNode, type EnergyFlow, type EnergyTotals, type H2Ledger, type PvLossBreakdown, type SiteEnergyDay, type SiteEnergyDq, type SupplyNode } from '@/lib/analytics/ledger/types';
import { asArray, asNumber, asRecord, asString, type JsonRecord } from '@/lib/desk/json-read';

export interface LedgerDbRow {
  /** KST 'YYYY-MM-DD' */
  readonly day: string;
  readonly flows_kwh: unknown;
  readonly energy_kwh: unknown;
  readonly h2_kg: unknown;
  readonly elz_grid_share: number | null;
  readonly renewable_share: number | null;
  readonly elz_sec_kwh_per_kg: number | null;
  readonly fc_kg_per_mwh: number | null;
  readonly p2p_efficiency: number | null;
  readonly pv_loss_kwh: unknown;
  readonly dq: unknown;
  readonly calc_version: string;
}

const SUPPLY: readonly string[] = [...SUPPLY_NODES, UNMETERED];
const DEMAND: readonly string[] = [...DEMAND_NODES, UNMETERED];
const isSupply = (v: string | null): v is SupplyNode => v !== null && SUPPLY.includes(v);
const isDemand = (v: string | null): v is DemandNode => v !== null && DEMAND.includes(v);

const zero = (r: JsonRecord, key: string): number => asNumber(r[key]) ?? 0;

function flowsOf(value: unknown): EnergyFlow[] {
  return asArray(value).flatMap((item) => {
    const r = asRecord(item);
    const from = asString(r.from);
    const to = asString(r.to);
    const kwh = asNumber(r.kwh);
    return isSupply(from) && isDemand(to) && kwh !== null ? [{ from, to, kwh }] : [];
  });
}

function energyOf(value: unknown): EnergyTotals {
  const r = asRecord(value);
  return {
    pv: zero(r, 'pv'),
    ess_discharge: zero(r, 'ess_discharge'),
    fc: zero(r, 'fc'),
    grid_import: zero(r, 'grid_import'),
    site_aux: zero(r, 'site_aux'),
    ess_charge: zero(r, 'ess_charge'),
    electrolyzer: zero(r, 'electrolyzer'),
    electrolyzer_system: zero(r, 'electrolyzer_system'),
    compressor: zero(r, 'compressor'),
    grid_export: zero(r, 'grid_export'),
    unmetered_supply: zero(r, 'unmetered_supply'),
    unmetered_demand: zero(r, 'unmetered_demand'),
  };
}

function h2Of(value: unknown): H2Ledger {
  const r = asRecord(value);
  const method = asRecord(r.method);
  const aux = asRecord(r.aux);
  const produced = asString(method.produced);
  const delivered = asString(method.delivered);
  return {
    produced: asNumber(r.produced),
    delivered: asNumber(r.delivered),
    fc_consumed: asNumber(r.fc_consumed),
    stored_delta: asNumber(r.stored_delta),
    vented_est: asNumber(r.vented_est),
    residual: asNumber(r.residual),
    residual_pct: asNumber(r.residual_pct),
    method: {
      produced: produced === 'meter_total' || produced === 'meter' || produced === 'faraday_estimate' ? produced : null,
      delivered: delivered === 'meter' || delivered === 'invoice' ? delivered : null,
      fc_consumed: method.fc_consumed === 'meter' ? 'meter' : null,
      stored_delta: asString(method.stored_delta),
      vented: method.vented === 'params' ? 'params' : 'not_estimated',
    },
    aux: { faraday_expected: asNumber(aux.faraday_expected), purge_count: asNumber(aux.purge_count), tank_temp_delta_c: asNumber(aux.tank_temp_delta_c) },
  };
}

function pvLossOf(value: unknown): PvLossBreakdown | null {
  if (value === null || typeof value !== 'object') return null;
  const r = asRecord(value);
  return {
    expected: zero(r, 'expected'),
    actual: zero(r, 'actual'),
    outage: zero(r, 'outage'),
    ess_full: zero(r, 'ess_full'),
    curtailment: zero(r, 'curtailment'),
    clipping: zero(r, 'clipping'),
    derating: zero(r, 'derating'),
    soiling_est: zero(r, 'soiling_est'),
    unexplained: zero(r, 'unexplained'),
  };
}

function completenessMap(value: unknown): Record<string, number | null> {
  return Object.fromEntries(Object.entries(asRecord(value)).map(([key, v]) => [key, asNumber(v)]));
}

function dqOf(value: unknown): SiteEnergyDq {
  const r = asRecord(value);
  const energy = asRecord(r.energy);
  const h2 = asRecord(r.h2);
  const pv = asRecord(r.pv);
  const basis = (v: unknown) => (v === 'rectifier_input' || v === 'system_total' ? v : null);
  return {
    energy: {
      completeness: completenessMap(energy.completeness),
      aux_basis: energy.aux_basis === 'estimate' ? 'estimate' : 'residual',
      aux_residual_kwh: zero(energy, 'aux_residual_kwh'),
      unmetered_kwh: zero(energy, 'unmetered_kwh'),
      unmetered_ratio: asNumber(energy.unmetered_ratio),
      elz_flow_basis: basis(energy.elz_flow_basis),
      elz_energy_basis: basis(energy.elz_energy_basis),
    },
    h2: { completeness: asNumber(h2.completeness), purge_count_missing: h2.purge_count_missing === true, delivered_missing: h2.delivered_missing === true },
    pv: {
      completeness: asNumber(pv.completeness),
      pr_ref: asNumber(pv.pr_ref),
      pr_ref_method: pv.pr_ref_method === 'params' || pv.pr_ref_method === 'reference_clear_days' ? pv.pr_ref_method : null,
      soiling_status: pv.soiling_status === 'estimated' ? 'estimated' : 'not_estimated',
      temp_corrected_ratio: asNumber(pv.temp_corrected_ratio),
      no_data_inverter_hours: zero(pv, 'no_data_inverter_hours'),
      reason: asString(pv.reason),
    },
  };
}

export function parseLedgerRow(row: LedgerDbRow): SiteEnergyDay {
  return {
    day: row.day,
    flows_kwh: flowsOf(row.flows_kwh),
    energy_kwh: energyOf(row.energy_kwh),
    h2_kg: h2Of(row.h2_kg),
    elz_grid_share: row.elz_grid_share,
    renewable_share: row.renewable_share,
    elz_sec_kwh_per_kg: row.elz_sec_kwh_per_kg,
    fc_kg_per_mwh: row.fc_kg_per_mwh,
    p2p_efficiency: row.p2p_efficiency,
    pv_loss_kwh: pvLossOf(row.pv_loss_kwh),
    dq: dqOf(row.dq),
    alloc_version: ALLOC_VERSION,
    calc_version: row.calc_version,
  };
}
