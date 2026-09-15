// 원장 공용 도우미: 하루(KST) 문맥, m_1h 행 색인, 시간 에너지·경계값·완결성.
import { kstDayStart, MS_PER_HOUR } from '../types';
import type { LedgerAsset, LedgerHourRow } from './types';

export const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3_600;

/** 원장이 읽는 메트릭. 나머지 행은 색인에 넣지 않는다 (한정자별 포인트가 여러 개인 메트릭과 섞이지 않게) */
export const LEDGER_METRICS: ReadonlySet<string> = new Set([
  'ac.power',
  'fc.ac.power',
  'compressor.power',
  'h2.flow.mass',
  'stack.current',
  'fc.h2.consumption',
  'tank.pressure',
  'tank.temp',
  'purge.count',
  'poa.irradiance',
  'module.temp',
  'ac.power.limit',
  'op.state',
  'heatsink.temp',
  'batt.soc',
]);

export interface LedgerContext {
  /** KST 0시 (epoch ms) */
  readonly dayStart: number;
  /** 그날 24개 정시 */
  readonly hours: readonly number[];
  readonly assets: readonly LedgerAsset[];
  readonly fallbackPeriodS: number;
  row(assetId: number, metricKey: string, hourStart: number): LedgerHourRow | undefined;
}

const rowKey = (assetId: number, metricKey: string, hourStart: number): string => `${assetId}|${metricKey}|${hourStart}`;

/**
 * rows는 [dayStart − 1 h, dayStart + 24 h) 범위를 넣는다. 앞 1시간 행은 누적 카운터·탱크 재고의 시작 경계값에만 쓴다.
 * 같은 (설비, 메트릭, 시각) 행이 두 개면 어느 포인트인지 알 수 없으므로 오류로 멈춘다.
 */
export function createLedgerContext(dayStart: number, assets: readonly LedgerAsset[], rows: readonly LedgerHourRow[], fallbackPeriodS: number): LedgerContext {
  if (kstDayStart(dayStart) !== dayStart) throw new RangeError(`원장 날짜 시작이 KST 0시가 아닙니다: ${new Date(dayStart).toISOString()}`);
  const index = new Map<string, LedgerHourRow>();
  for (const r of rows) {
    if (!LEDGER_METRICS.has(r.metricKey)) continue;
    const key = rowKey(r.assetId, r.metricKey, r.hourStart);
    if (index.has(key)) throw new Error(`원장 입력에 같은 설비·메트릭·시각 행이 두 개 있습니다: ${key}`);
    index.set(key, r);
  }
  return {
    dayStart,
    hours: Array.from({ length: HOURS_PER_DAY }, (_, i) => dayStart + i * MS_PER_HOUR),
    assets,
    fallbackPeriodS,
    row: (assetId, metricKey, hourStart) => index.get(rowKey(assetId, metricKey, hourStart)),
  };
}

const byCode = (a: LedgerAsset, b: LedgerAsset): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

export const assetsOf = (ctx: LedgerContext, classKey: string): LedgerAsset[] => ctx.assets.filter((a) => a.classKey === classKey).sort(byCode);

export function nameplateNumber(asset: LedgerAsset, key: string): number | null {
  const value = Number(asset.nameplate[key]);
  return Number.isFinite(value) ? value : null;
}

/** good 샘플이 있는 행의 시간 평균 */
export function goodAvg(row: LedgerHourRow | undefined): number | null {
  return row && row.nGood > 0 && row.avg !== null && Number.isFinite(row.avg) ? row.avg : null;
}

/** 한 시간 적분 [단위·h] = integral ?? avg × 1 h */
export function hourIntegral(row: LedgerHourRow | undefined): number | null {
  const avg = goodAvg(row);
  if (avg === null) return null;
  const integral = row?.integral;
  return integral !== undefined && integral !== null && Number.isFinite(integral) ? integral : avg;
}

/** 시간 최댓값 (max 열이 없으면 first·last·avg 중 큰 값) */
export function hourMax(row: LedgerHourRow | undefined): number | null {
  if (!row || row.nGood <= 0) return null;
  if (row.max !== undefined && row.max !== null) return row.max;
  const values = [row.first, row.last, row.avg].filter((v): v is number => v !== null && Number.isFinite(v));
  return values.length > 0 ? Math.max(...values) : null;
}

/** 시간 최솟값 (min 열이 없으면 first·last·avg 중 작은 값) */
export function hourMin(row: LedgerHourRow | undefined): number | null {
  if (!row || row.nGood <= 0) return null;
  if (row.min !== undefined && row.min !== null) return row.min;
  const values = [row.first, row.last, row.avg].filter((v): v is number => v !== null && Number.isFinite(v));
  return values.length > 0 ? Math.min(...values) : null;
}

export interface SignedEnergy {
  /** 설비별 양수 부분 합 */
  readonly pos: number;
  /** 설비별 음수 부분의 크기 합 */
  readonly neg: number;
  /** good 행이 하나라도 있었는지 */
  readonly measured: boolean;
}

/** 한 시간, 한 설비 종류의 전력 메트릭 에너지 [kWh]를 설비마다 부호로 나눠 합한다 */
export function signedEnergy(ctx: LedgerContext, classKey: string, metricKey: string, hourStart: number): SignedEnergy {
  return assetsOf(ctx, classKey).reduce<SignedEnergy>(
    (acc, asset) => {
      const kwh = hourIntegral(ctx.row(asset.id, metricKey, hourStart));
      if (kwh === null) return acc;
      return { pos: acc.pos + Math.max(0, kwh), neg: acc.neg + Math.max(0, -kwh), measured: true };
    },
    { pos: 0, neg: 0, measured: false },
  );
}

/** 그날 한 설비 종류·메트릭에 good 행이 있었는지 */
export const hasDayData = (ctx: LedgerContext, classKey: string, metricKey: string): boolean =>
  assetsOf(ctx, classKey).some((asset) => ctx.hours.some((h) => goodAvg(ctx.row(asset.id, metricKey, h)) !== null));

/** 완결성 = Σ n_good / Σ(24 × 3600 / period_s). 설비가 없으면 null. 행이 전혀 없는 설비는 fallbackPeriodS로 분모를 잡는다 */
export function dayCompleteness(ctx: LedgerContext, classKey: string, metricKey: string): number | null {
  const assets = assetsOf(ctx, classKey);
  if (assets.length === 0) return null;
  let good = 0;
  let expected = 0;
  for (const asset of assets) {
    const rows = ctx.hours.map((h) => ctx.row(asset.id, metricKey, h)).filter((r): r is LedgerHourRow => r !== undefined);
    const periodS = rows[0]?.periodS ?? ctx.fallbackPeriodS;
    const perHour = SECONDS_PER_HOUR / periodS;
    good += rows.reduce((sum, r) => sum + Math.min(r.nGood, perHour), 0);
    expected += HOURS_PER_DAY * perHour;
  }
  return expected > 0 ? Math.min(1, good / expected) : null;
}

export interface DayBoundary {
  readonly start: number | null;
  readonly end: number | null;
}

/**
 * 하루 경계값: 시작 = 앞 1시간 행의 last(있으면), 없으면 그날 첫 good 행의 first / 끝 = 그날 마지막 good 행의 last.
 * 연속한 두 날의 끝·시작이 같은 샘플이 되어 재고·카운터 차분이 날 사이에서 비거나 겹치지 않는다.
 */
export function dayBoundary(ctx: LedgerContext, assetId: number, metricKey: string): DayBoundary {
  const before = ctx.row(assetId, metricKey, ctx.dayStart - MS_PER_HOUR);
  const inDay = ctx.hours.map((h) => ctx.row(assetId, metricKey, h)).filter((r): r is LedgerHourRow => r !== undefined && r.nGood > 0);
  const previousLast = before && before.nGood > 0 ? before.last : null;
  return {
    start: previousLast ?? inDay[0]?.first ?? null,
    end: inDay[inDay.length - 1]?.last ?? null,
  };
}

export const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const roundOrNull = (value: number | null, digits: number): number | null => (value === null ? null : round(value, digits));

export const meanOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((sum, v) => sum + v, 0) / present.length;
};
