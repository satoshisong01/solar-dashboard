// 사이트 체인 원장 조립 (순수): 1시간 롤업 행 → KST 일별 SiteEnergyDay, 원장 일 행 → h2chain.mass_balance_gap 입력.
// DB 실행기(lib/analysis)와 시뮬레이터 평가(lib/sim/eval)가 같은 함수를 쓴다.
import type { H2LedgerDayInput } from '../detectors/h2chain-mass-balance';
import type { CandidateFinding } from '../detectors/types';
import { buildSiteEnergyDay } from '../ledger/site-day';
import { estimateReferencePr } from '../ledger/pr-reference';
import type { LedgerParams } from '../ledger/params';
import type { H2Ledger, LedgerAsset, LedgerHourRow, PrReference, SiteEnergyDay } from '../ledger/types';
import { kstDayStart, KST_OFFSET_MS, MS_PER_DAY, MS_PER_HOUR } from '../types';

/** 원장 일 행 중 물질수지 탐지에 쓰는 부분 (om.site_energy_daily h2_kg·dq.h2) */
export interface LedgerDayRow {
  /** KST 0시 epoch ms */
  readonly dayStart: number;
  readonly h2: H2Ledger;
  readonly h2Completeness: number | null;
}

/** KST 날짜 문자열 → 0시 epoch ms */
export const kstDayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`) - KST_OFFSET_MS;

export const ledgerDayRowOf =(day: SiteEnergyDay): LedgerDayRow => ({ dayStart: kstDayMs(day.day), h2: day.h2_kg, h2Completeness: day.dq.h2.completeness });

/** 원장 일 행 → 물질수지 탐지기 입력 (필드 이름이 같아 그대로 옮기고 판별 체크 보조값만 풀어 넣는다) */
export function massBalanceDays(rows: readonly LedgerDayRow[]): H2LedgerDayInput[] {
  return rows.map(({ dayStart, h2, h2Completeness }) => ({
    day: dayStart,
    produced: h2.produced,
    fc_consumed: h2.fc_consumed,
    stored_delta: h2.stored_delta,
    vented_est: h2.vented_est,
    residual: h2.residual,
    residual_pct: h2.residual_pct,
    dq: { completeness: h2Completeness },
    faraday_expected: h2.aux.faraday_expected,
    purge_count: h2.aux.purge_count,
    tank_temp_delta_c: h2.aux.tank_temp_delta_c,
  }));
}

/** [start, end) 안에서 끝난 KST 날짜들의 0시 (하루가 end 전에 다 끝난 날만) */
export function completeKstDays(window: { readonly start: number; readonly end: number }): number[] {
  const first = kstDayStart(window.start);
  const count = Math.max(0, Math.floor((window.end - first) / MS_PER_DAY));
  return Array.from({ length: count }, (_, i) => first + i * MS_PER_DAY).filter((day) => day + MS_PER_DAY <= window.end);
}

/** 행을 날짜별로 나눈다: [day − 1 h, day + 24 h) — 앞 1시간은 경계값용이라 두 날에 함께 들어간다 */
function rowsByDay(rows: readonly LedgerHourRow[], dayStarts: readonly number[]): Map<number, LedgerHourRow[]> {
  const byDay = new Map<number, LedgerHourRow[]>(dayStarts.map((d) => [d, []]));
  for (const row of rows) {
    const day = kstDayStart(row.hourStart);
    byDay.get(day)?.push(row); // 이 함수 안에서 만든 배열만 채운다
    if (row.hourStart === day + MS_PER_DAY - MS_PER_HOUR) byDay.get(day + MS_PER_DAY)?.push(row);
  }
  return byDay;
}

export interface SiteLedgerInput {
  readonly assets: readonly LedgerAsset[];
  /** 대상 날짜들을 덮는 m_1h 행 (첫날 앞 1시간 포함) */
  readonly rows: readonly LedgerHourRow[];
  readonly dayStarts: readonly number[];
  readonly prRef: PrReference | null;
  /** 날짜 0시 → 인버터 id → 오염 손실률 0~1 */
  readonly soilingByDay?: ReadonlyMap<number, ReadonlyMap<number, number>>;
  readonly params?: Partial<LedgerParams>;
}

/** 그날(앞 1시간 경계 행 제외) 1시간 롤업 행이 하나도 없는 날은 원장을 만들지 않는다 (수집 전·중단 기간을 0으로 적지 않게) */
export function buildLedgerDays(input: SiteLedgerInput): SiteEnergyDay[] {
  const byDay = rowsByDay(input.rows, input.dayStarts);
  return input.dayStarts.filter((dayStart) => (byDay.get(dayStart) ?? []).some((row) => row.hourStart >= dayStart)).map((dayStart) =>
    buildSiteEnergyDay({ dayStart, assets: input.assets, rows: byDay.get(dayStart) ?? [], prRef: input.prRef, soilingLossByAssetId: input.soilingByDay?.get(dayStart), params: input.params }),
  );
}

/** 기준 PR 추정에 쓰는 기간: 사이트 첫 데이터 날부터 이 일수 */
export const PR_REFERENCE_DAYS = 30;

/** 첫 데이터 날부터 PR_REFERENCE_DAYS일 맑은 날 온도보정 PR 중앙값 (분석 기간과 무관해 다시 실행해도 같다) */
export function referencePrOf(assets: readonly LedgerAsset[], rows: readonly LedgerHourRow[], firstDataMs: number | null, params?: Partial<LedgerParams>): PrReference | null {
  if (firstDataMs === null) return null;
  const first = kstDayStart(firstDataMs) + MS_PER_DAY; // 첫날은 수집 시작 시각이 섞여 뺀다
  const dayStarts = Array.from({ length: PR_REFERENCE_DAYS }, (_, i) => first + i * MS_PER_DAY);
  return estimateReferencePr({ assets, rows, dayStarts, params }).reference;
}

/** 기준 PR 추정에 필요한 행 범위 */
export const referencePrWindow = (firstDataMs: number): { start: number; end: number } => {
  const start = kstDayStart(firstDataMs) + MS_PER_DAY - MS_PER_HOUR;
  return { start, end: start + MS_PER_HOUR + PR_REFERENCE_DAYS * MS_PER_DAY };
};

/**
 * pv.soiling_rate finding → 날짜별 인버터 오염 손실률. 현재 무세척 구간(windowStart ~ windowEnd) 안의 날만
 * 오염 속도 × 경과일로 채운다 (탐지기 lossPctAt과 같은 선형 누적). finding이 없으면 빈 맵 → 원장은 오염 손실을 추정하지 않는다.
 */
export function soilingFractionsByDay(finding: CandidateFinding | null, inverterIds: readonly number[], dayStarts: readonly number[]): Map<number, Map<number, number>> {
  const rate = finding?.evidence.rate_pct_per_day;
  if (!finding || typeof rate !== 'number' || !(rate > 0)) return new Map();
  return new Map(
    dayStarts
      .filter((day) => day >= finding.windowStart && day < finding.windowEnd)
      .map((day) => {
        const fraction = Math.min(0.9, (rate * ((day + MS_PER_DAY / 2 - finding.windowStart) / MS_PER_DAY)) / 100);
        return [day, new Map(inverterIds.map((id) => [id, fraction]))];
      }),
  );
}
