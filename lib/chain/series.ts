// 체인 원장 일별 차트·기간 합 표 데이터 (순수).
//   PV 미활용 누적 막대  날짜마다 버킷 kWh (분해가 없는 날은 null — 막대를 비우고 사유를 센다). 설명 안 됨은 음수일 수 있다(PR_ref 과소 추정 신호).
//   물질수지 잔차        잔차 kg·% 와 수소 원장 완결성. 완결성이 기준 미만인 날은 low로 표시해 판정에서 빠지는 날을 드러낸다.
//   전해조 전력 비율      일별 계통·재생 비율, 기간 값은 kWh 가중(할당 흐름 합 ÷ 전해조 kWh 합)
import type { PvLossBucket, SiteEnergyDay } from '@/lib/analytics/ledger/types';
import { PV_LOSS_DISPLAY } from './labels';

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export interface PvLossSeries {
  readonly bucket: PvLossBucket;
  readonly label: string;
  /** 날짜 순서와 같은 길이 */
  readonly values: readonly (number | null)[];
}

export interface PvLossTotal {
  readonly bucket: PvLossBucket;
  readonly label: string;
  readonly kwh: number;
  /** 기대 발전량 대비 [%] (기대가 0이면 null) */
  readonly pctOfExpected: number | null;
}

export interface PvLossView {
  readonly days: readonly string[];
  readonly series: readonly PvLossSeries[];
  readonly totals: readonly PvLossTotal[];
  readonly expectedKwh: number;
  readonly actualKwh: number;
  /** 분해가 있는 날 수 */
  readonly daysWithBreakdown: number;
  /** 분해가 없는 날의 사유 코드별 날 수 */
  readonly missingReasons: Readonly<Record<string, number>>;
}

export function pvLossView(days: readonly SiteEnergyDay[]): PvLossView {
  const withBreakdown = days.filter((d) => d.pv_loss_kwh !== null);
  const expected = withBreakdown.reduce((sum, d) => sum + (d.pv_loss_kwh?.expected ?? 0), 0);
  const missingReasons = days
    .filter((d) => d.pv_loss_kwh === null)
    .reduce<Record<string, number>>((acc, d) => {
      const reason = d.dq.pv.reason ?? 'unknown';
      return { ...acc, [reason]: (acc[reason] ?? 0) + 1 };
    }, {});
  return {
    days: days.map((d) => d.day),
    series: PV_LOSS_DISPLAY.map(([bucket, label]) => ({ bucket, label, values: days.map((d) => (d.pv_loss_kwh === null ? null : round(d.pv_loss_kwh[bucket], 1))) })),
    totals: PV_LOSS_DISPLAY.map(([bucket, label]) => {
      const kwh = withBreakdown.reduce((sum, d) => sum + (d.pv_loss_kwh?.[bucket] ?? 0), 0);
      return { bucket, label, kwh: round(kwh, 1), pctOfExpected: expected > 0 ? round((kwh / expected) * 100, 2) : null };
    }),
    expectedKwh: round(expected, 1),
    actualKwh: round(withBreakdown.reduce((sum, d) => sum + (d.pv_loss_kwh?.actual ?? 0), 0), 1),
    daysWithBreakdown: withBreakdown.length,
    missingReasons,
  };
}

export interface ResidualPoint {
  readonly day: string;
  readonly residualKg: number;
  readonly residualPct: number | null;
  readonly completeness: number | null;
  /** 완결성이 기준 미만 (물질수지 탐지에서 빠지는 날) */
  readonly low: boolean;
}

export function residualPoints(days: readonly SiteEnergyDay[], minCompleteness: number): ResidualPoint[] {
  return days.flatMap((d) =>
    d.h2_kg.residual === null
      ? []
      : [{ day: d.day, residualKg: d.h2_kg.residual, residualPct: d.h2_kg.residual_pct, completeness: d.dq.h2.completeness, low: (d.dq.h2.completeness ?? 0) < minCompleteness }],
  );
}

export interface SharePoint {
  readonly day: string;
  readonly gridShare: number;
  readonly renewableShare: number;
}

export interface ShareView {
  readonly points: readonly SharePoint[];
  /** kWh 가중 기간 값 (전해조 전력이 minElzKwh 미만이면 null) */
  readonly gridShare: number | null;
  readonly renewableShare: number | null;
  readonly electrolyzerKwh: number;
}

const flowSum = (day: SiteEnergyDay, from: readonly string[]): number => day.flows_kwh.filter((f) => f.to === 'electrolyzer' && from.includes(f.from)).reduce((sum, f) => sum + f.kwh, 0);

export function shareView(days: readonly SiteEnergyDay[], minElzKwh = 1): ShareView {
  const used = days.filter((d) => d.elz_grid_share !== null && d.renewable_share !== null);
  const electrolyzerKwh = used.reduce((sum, d) => sum + d.energy_kwh.electrolyzer, 0);
  const grid = used.reduce((sum, d) => sum + flowSum(d, ['grid_import']), 0);
  const renewable = used.reduce((sum, d) => sum + flowSum(d, ['pv', 'ess_discharge']), 0);
  const enough = electrolyzerKwh >= minElzKwh;
  return {
    points: used.map((d) => ({ day: d.day, gridShare: d.elz_grid_share as number, renewableShare: d.renewable_share as number })),
    gridShare: enough ? round(grid / electrolyzerKwh, 4) : null,
    renewableShare: enough ? round(renewable / electrolyzerKwh, 4) : null,
    electrolyzerKwh: round(electrolyzerKwh, 1),
  };
}
