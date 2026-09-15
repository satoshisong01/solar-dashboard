// 사이트 체인 원장 (om.site_energy_daily): m_1h 1시간 롤업만 읽어 lib/analytics/ledger 순수 계산 → 날짜별 upsert (겹침 구간은 다시 계산해 덮어쓴다).
// 기준 PR은 사이트 첫 데이터 날부터 30일 맑은 날로 추정한다(분석 기간과 무관해 다시 실행해도 같다).
import { sql, type Kysely } from 'kysely';
import { LEDGER_METRICS } from '@/lib/analytics/ledger/hourly';
import type { H2Ledger, LedgerAsset, SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { buildLedgerDays, completeKstDays, kstDayMs, referencePrOf, referencePrWindow, soilingFractionsByDay, type LedgerDayRow } from '@/lib/analytics/pipeline/site-ledger';
import type { DetectorOutcome, PipelineAsset } from '@/lib/analytics/pipeline/types';
import { MS_PER_DAY, MS_PER_HOUR, type TimeWindow } from '@/lib/analytics/types';
import type { DB } from '@/lib/db/types';
import type { PointRow } from './catalog';
import { firstHourWithData, loadHourly } from './series';

const UPSERT_BATCH = 200;

export interface LedgerStats {
  readonly days: number;
  readonly hourRows: number;
  readonly prRef: number | null;
  readonly soilingDays: number;
}

const ledgerAssets = (assets: readonly PipelineAsset[]): LedgerAsset[] => assets.map((a) => ({ id: a.id, code: a.code, classKey: a.classKey, nameplate: a.nameplate }));

async function upsertDays(db: Kysely<DB>, siteId: number, runId: string, days: readonly SiteEnergyDay[], computedAt: Date): Promise<void> {
  const values = days.map((d) => ({
    site_id: siteId,
    day: sql<Date>`${d.day}::date`,
    flows_kwh: JSON.stringify(d.flows_kwh),
    energy_kwh: JSON.stringify(d.energy_kwh),
    h2_kg: JSON.stringify(d.h2_kg),
    elz_grid_share: d.elz_grid_share,
    renewable_share: d.renewable_share,
    elz_sec_kwh_per_kg: d.elz_sec_kwh_per_kg,
    fc_kg_per_mwh: d.fc_kg_per_mwh,
    p2p_efficiency: d.p2p_efficiency,
    pv_loss_kwh: d.pv_loss_kwh === null ? null : JSON.stringify(d.pv_loss_kwh),
    dq: JSON.stringify(d.dq),
    alloc_version: d.alloc_version,
    calc_version: d.calc_version,
    run_id: runId,
    computed_at: computedAt,
  }));
  for (let i = 0; i < values.length; i += UPSERT_BATCH) {
    await db
      .insertInto('om.site_energy_daily')
      .values(values.slice(i, i + UPSERT_BATCH))
      .onConflict((oc) =>
        oc.columns(['site_id', 'day']).doUpdateSet((eb) => ({
          flows_kwh: eb.ref('excluded.flows_kwh'),
          energy_kwh: eb.ref('excluded.energy_kwh'),
          h2_kg: eb.ref('excluded.h2_kg'),
          elz_grid_share: eb.ref('excluded.elz_grid_share'),
          renewable_share: eb.ref('excluded.renewable_share'),
          elz_sec_kwh_per_kg: eb.ref('excluded.elz_sec_kwh_per_kg'),
          fc_kg_per_mwh: eb.ref('excluded.fc_kg_per_mwh'),
          p2p_efficiency: eb.ref('excluded.p2p_efficiency'),
          pv_loss_kwh: eb.ref('excluded.pv_loss_kwh'),
          dq: eb.ref('excluded.dq'),
          alloc_version: eb.ref('excluded.alloc_version'),
          calc_version: eb.ref('excluded.calc_version'),
          run_id: eb.ref('excluded.run_id'),
          computed_at: eb.ref('excluded.computed_at'),
        })),
      )
      .execute();
  }
}

export interface ComputeLedgerInput {
  readonly siteId: number;
  readonly runId: string;
  readonly assets: readonly PipelineAsset[];
  readonly points: readonly PointRow[];
  /** 다시 계산할 구간 (그 안에서 하루가 다 끝난 KST 날짜만) */
  readonly window: TimeWindow;
  /** 같은 실행의 pv.soiling_rate 결과 (오염 손실 추정) */
  readonly outcomes: readonly DetectorOutcome[];
  readonly computedAt: Date;
}

/** 원장 계산·저장. 원장 대상 포인트가 없으면 0일 */
export async function computeSiteLedger(db: Kysely<DB>, input: ComputeLedgerInput): Promise<LedgerStats> {
  const dayStarts = completeKstDays(input.window);
  const ledgerPoints = input.points.filter((p) => LEDGER_METRICS.has(p.metricKey));
  if (dayStarts.length === 0 || ledgerPoints.length === 0) return { days: 0, hourRows: 0, prRef: null, soilingDays: 0 };
  const assets = ledgerAssets(input.assets);
  const firstDay = dayStarts[0] as number;
  const rows = await loadHourly(db, ledgerPoints, { start: firstDay - MS_PER_HOUR, end: (dayStarts.at(-1) as number) + MS_PER_DAY });
  const pvPoints = ledgerPoints.filter((p) => p.metricKey === 'ac.power' && input.assets.some((a) => a.id === p.assetId && a.classKey === 'pv.inverter'));
  const firstPv = await firstHourWithData(db, pvPoints.map((p) => p.pointId));
  const pvRelated = new Set(input.assets.filter((a) => a.classKey === 'pv.inverter' || a.classKey === 'wx.station').map((a) => a.id));
  const prRows = firstPv === null ? [] : await loadHourly(db, ledgerPoints.filter((p) => pvRelated.has(p.assetId)), referencePrWindow(firstPv));
  const prRef = referencePrOf(assets, prRows, firstPv);
  const soiling = input.outcomes.find((o) => o.detectorId === 'pv.soiling_rate' && o.siteId === input.siteId)?.findings[0] ?? null;
  const soilingByDay = soilingFractionsByDay(soiling, input.assets.filter((a) => a.classKey === 'pv.inverter').map((a) => a.id), dayStarts);
  const days = buildLedgerDays({ assets, rows, dayStarts, prRef, soilingByDay });
  await upsertDays(db, input.siteId, input.runId, days, input.computedAt);
  return { days: days.length, hourRows: rows.length, prRef: prRef?.value ?? null, soilingDays: soilingByDay.size };
}

/** 저장된 원장 일 행 (물질수지 탐지 입력, until 이전에 끝난 날) */
export async function loadLedgerDays(db: Kysely<DB>, siteId: number, until: number): Promise<LedgerDayRow[]> {
  const { rows } = await sql<{ day: string; h2_kg: H2Ledger; completeness: number | null }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, h2_kg, (dq -> 'h2' ->> 'completeness')::float8 AS completeness
    FROM om.site_energy_daily
    WHERE site_id = ${siteId} AND day + 1 <= (${new Date(until).toISOString()}::timestamptz AT TIME ZONE 'Asia/Seoul')::date
    ORDER BY day
  `.execute(db);
  return rows.map((r) => ({ dayStart: kstDayMs(r.day), h2: r.h2_kg, h2Completeness: r.completeness }));
}
