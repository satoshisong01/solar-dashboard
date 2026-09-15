// 에너지·수소 체인 원장 일 행(om.site_energy_daily) → 팩 기간 합 (순수). 사이트 상세 체인 원장 섹션과 같은 합산 규칙을 쓴다:
//   체인 KPI·잔차율 = summarizeChainPeriod(기간 합), 전해조 재생·계통 비율 = shareView(kWh 가중), PV 미활용 = pvLossView(분해가 있는 날 합).
// 일 행·시간 흐름은 팩에 넣지 않는다 (기간 합만).
import { summarizeChainPeriod } from '@/lib/analytics/ledger/site-day';
import type { SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { ledgerDqSummary } from '@/lib/chain/dq';
import { LEDGER_MIN_COMPLETENESS } from '@/lib/chain/limits';
import { pvLossView, shareView } from '@/lib/chain/series';
import { roundTo } from './pack-evidence-shared';
import type { PackEnergyLedger } from './pack-types-p3';

const kwh = (value: number): number => roundTo(value, 1) ?? 0;
const pct = (ratio: number | null, digits = 1): number | null => roundTo(ratio === null ? null : ratio * 100, digits);
const kstMidnight = (day: string): number => Date.parse(`${day}T00:00:00+09:00`);

/** 원장 일 행이 없으면 null */
export function energyLedgerOf(days: readonly SiteEnergyDay[]): PackEnergyLedger | null {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  const sum = (pick: (d: SiteEnergyDay) => number) => sorted.reduce((acc, d) => acc + pick(d), 0);
  const summary = summarizeChainPeriod(sorted);
  const used = sorted.filter((d) => d.h2_kg.produced !== null && d.h2_kg.fc_consumed !== null && d.h2_kg.residual !== null);
  const shares = shareView(sorted);
  const pvLoss = pvLossView(sorted);
  return {
    days: sorted.length,
    firstDay: kstMidnight(first.day),
    lastDay: kstMidnight(last.day),
    allocVersion: first.alloc_version,
    calcVersions: [...new Set(sorted.map((d) => d.calc_version))].sort(),
    energy: {
      pvKwh: kwh(sum((d) => d.energy_kwh.pv)),
      essDischargeKwh: kwh(sum((d) => d.energy_kwh.ess_discharge)),
      fcKwh: kwh(sum((d) => d.energy_kwh.fc)),
      gridImportKwh: kwh(sum((d) => d.energy_kwh.grid_import)),
      siteAuxKwh: kwh(sum((d) => d.energy_kwh.site_aux)),
      essChargeKwh: kwh(sum((d) => d.energy_kwh.ess_charge)),
      electrolyzerKwh: kwh(sum((d) => d.energy_kwh.electrolyzer)),
      compressorKwh: kwh(sum((d) => d.energy_kwh.compressor)),
      gridExportKwh: kwh(sum((d) => d.energy_kwh.grid_export)),
      unmeteredKwh: kwh(sum((d) => d.dq.energy.unmetered_kwh)),
    },
    hydrogen:
      summary.daysUsed === 0
        ? null
        : {
            daysUsed: summary.daysUsed,
            producedKg: roundTo(summary.producedKg, 1) ?? 0,
            fcConsumedKg: roundTo(summary.fcConsumedKg, 1) ?? 0,
            storedDeltaKg: roundTo(used.reduce((acc, d) => acc + (d.h2_kg.stored_delta ?? 0), 0), 1) ?? 0,
            ventedEstKg: roundTo(used.reduce((acc, d) => acc + (d.h2_kg.vented_est ?? 0), 0), 2) ?? 0,
            residualKg: roundTo(summary.residualKg, 2) ?? 0,
            residualPct: roundTo(summary.residualPct, 2),
          },
    kpis: {
      elzSecKwhPerKg: roundTo(summary.elzSecKwhPerKg, 1),
      fcKgPerMwh: roundTo(summary.fcKgPerMwh, 1),
      p2pEfficiencyPct: pct(summary.p2pEfficiency),
      renewableSharePct: pct(shares.renewableShare),
      gridSharePct: pct(shares.gridShare),
    },
    pvLoss:
      pvLoss.daysWithBreakdown === 0
        ? null
        : { daysWithBreakdown: pvLoss.daysWithBreakdown, expectedKwh: roundTo(pvLoss.expectedKwh, 0) ?? 0, actualKwh: roundTo(pvLoss.actualKwh, 0) ?? 0, items: pvLoss.totals.map((t) => ({ bucket: t.bucket, label: t.label, kwh: roundTo(t.kwh, 0) ?? 0, pctOfExpected: roundTo(t.pctOfExpected, 2) })) },
    unmeteredRatioPct: pct(ledgerDqSummary(sorted).periodUnmeteredRatio, 2),
    lowH2CompletenessDays: sorted.filter((d) => d.dq.h2.completeness !== null && d.dq.h2.completeness < LEDGER_MIN_COMPLETENESS).length,
  };
}
