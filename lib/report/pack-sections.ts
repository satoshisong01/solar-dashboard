// 팩의 KPI·데이터 품질·검증된 조치·수익 요약 조립 (순수). 입력은 load.ts가 읽은 DB 행.
import { VERIFICATION_METRICS } from '@/lib/analytics/verification/before-after';
import { asNumber, asRecord } from '@/lib/desk/json-read';
import { isMarketKey, MARKET_LABELS } from '@/lib/market/keys';
import { kpiDisplay } from './kpi-labels';
import { roundTo } from './pack-evidence';
import type { PackDataQuality, PackKpi, PackKpiAsset, PackLowCompleteness, PackRevenue, PackVerifiedAction } from './pack-types';

/** 데이터 완결성이 이 값[%] 미만인 설비 지표를 데이터 품질 요청으로 올린다 */
export const COMPLETENESS_THRESHOLD_PCT = 95;
const LOW_COMPLETENESS_LIMIT = 10;
const VERIFIED_ACTION_LIMIT = 20;

export interface KpiRowInput {
  readonly scopeType: 'site' | 'asset';
  /** asset 범위면 설비 경로 */
  readonly assetPath: string | null;
  /** KST 'YYYY-MM-DD' */
  readonly day: string;
  readonly key: string;
  readonly value: number | null;
  readonly dqCompleteness: number | null;
}

export interface VerificationInput {
  readonly id: string;
  readonly actionId: string;
  readonly findingId: string | null;
  readonly assetPath: string;
  readonly actionType: string;
  readonly performedAt: number;
  readonly verdict: string;
  readonly effect: number | null;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
  readonly beforeStats: unknown;
  readonly afterStats: unknown;
  readonly computedAt: number;
}

export interface MarketRowInput {
  readonly day: string;
  readonly key: string;
  readonly value: number;
  readonly unit: string;
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length);
const values = (rows: readonly KpiRowInput[]): number[] => rows.flatMap((r) => (r.value === null || !Number.isFinite(r.value) ? [] : [r.value]));
const completenessPct = (rows: readonly KpiRowInput[]): number | null => {
  const dq = mean(rows.flatMap((r) => (r.dqCompleteness === null ? [] : [r.dqCompleteness])));
  return roundTo(dq === null ? null : dq * 100, 1);
};

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  return items.reduce((map, item) => map.set(keyOf(item), [...(map.get(keyOf(item)) ?? []), item]), new Map<string, T[]>());
}

/** 지표별 설비 평균 (표시 단위) */
export function kpiAssetSummaries(rows: readonly KpiRowInput[]): PackKpiAsset[] {
  const assetRows = rows.filter((r) => r.scopeType === 'asset' && r.assetPath !== null);
  return [...groupBy(assetRows, (r) => `${r.key}|${r.assetPath}`).entries()]
    .map(([, group]) => {
      const first = group[0] as KpiRowInput;
      const display = kpiDisplay(first.key);
      const v = values(group);
      return { key: first.key, assetPath: first.assetPath ?? '', days: v.length, mean: roundTo(mean(v) === null ? null : (mean(v) as number) * display.scale, display.digits + 2), completenessPct: completenessPct(group) };
    })
    .sort((a, b) => (a.key === b.key ? a.assetPath.localeCompare(b.assetPath) : a.key.localeCompare(b.key)));
}

/** 지표별 요약: 사이트 범위 값이 있으면 그것, 없으면 설비 평균들의 평균·최소·최대 */
export function kpiSummaries(rows: readonly KpiRowInput[], assets: readonly PackKpiAsset[]): PackKpi[] {
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  return keys.flatMap((key): PackKpi[] => {
    const display = kpiDisplay(key);
    const digits = display.digits + 2;
    const scaled = (v: number | null) => roundTo(v === null ? null : v * display.scale, digits);
    const siteRows = rows.filter((r) => r.key === key && r.scopeType === 'site');
    const siteValues = values(siteRows);
    if (siteValues.length > 0) {
      return [{ key, label: display.label, unit: display.unit, scope: 'site', assetCount: 0, days: siteValues.length, total: display.additive ? scaled(siteValues.reduce((s, v) => s + v, 0)) : null, mean: scaled(mean(siteValues)), min: scaled(Math.min(...siteValues)), max: scaled(Math.max(...siteValues)), completenessPct: completenessPct(siteRows) }];
    }
    const perAsset = assets.filter((a) => a.key === key && a.mean !== null);
    if (perAsset.length === 0) return [];
    const means = perAsset.map((a) => a.mean as number);
    const assetRows = rows.filter((r) => r.key === key && r.scopeType === 'asset');
    return [{ key, label: display.label, unit: display.unit, scope: 'assets', assetCount: perAsset.length, days: Math.max(...perAsset.map((a) => a.days)), total: display.additive ? scaled(values(assetRows).reduce((s, v) => s + v, 0)) : null, mean: roundTo(mean(means), digits), min: roundTo(Math.min(...means), digits), max: roundTo(Math.max(...means), digits), completenessPct: completenessPct(assetRows) }];
  });
}

/** 설비별 가장 낮은 지표 완결성이 기준 미만이면 요청 목록에 (낮은 순, 최대 10개) */
export function dataQualityOf(assets: readonly PackKpiAsset[], dqFindingIds: readonly string[]): PackDataQuality {
  const lowest = [...groupBy(assets.filter((a) => a.completenessPct !== null), (a) => a.assetPath).values()].map((group) => [...group].sort((a, b) => (a.completenessPct ?? 0) - (b.completenessPct ?? 0))[0] as PackKpiAsset);
  const low = lowest
    .filter((a) => (a.completenessPct ?? 100) < COMPLETENESS_THRESHOLD_PCT)
    .sort((a, b) => (a.completenessPct ?? 0) - (b.completenessPct ?? 0) || a.assetPath.localeCompare(b.assetPath))
    .slice(0, LOW_COMPLETENESS_LIMIT)
    .map((a): PackLowCompleteness => ({ key: a.key, label: kpiDisplay(a.key).label, assetPath: a.assetPath, completenessPct: a.completenessPct ?? 0, days: a.days }));
  return { completenessThresholdPct: COMPLETENESS_THRESHOLD_PCT, lowCompleteness: low, findingIds: [...dqFindingIds] };
}

const VERDICTS: readonly PackVerifiedAction['verdict'][] = ['improved', 'no_change', 'worse', 'insufficient_data'];
const isVerdict = (value: string): value is PackVerifiedAction['verdict'] => (VERDICTS as readonly string[]).includes(value);

export function verifiedActionsOf(rows: readonly VerificationInput[]): PackVerifiedAction[] {
  return rows
    .flatMap((row): PackVerifiedAction[] => {
      if (!isVerdict(row.verdict)) return [];
      const before = asRecord(row.beforeStats);
      const metric = typeof before.metric === 'string' ? before.metric : '';
      const spec = VERIFICATION_METRICS[metric];
      const digits = spec?.unit === 'V' ? 5 : 3;
      return [
        {
          verificationId: row.id,
          actionId: row.actionId,
          findingId: row.findingId,
          assetPath: row.assetPath,
          actionType: row.actionType,
          performedAt: row.performedAt,
          metric,
          metricLabel: spec?.label ?? metric,
          unit: spec?.unit ?? (typeof before.unit === 'string' ? before.unit : ''),
          verdict: row.verdict,
          effect: roundTo(row.effect, digits),
          ciLow: roundTo(row.ciLow, digits),
          ciHigh: roundTo(row.ciHigh, digits),
          beforeN: asNumber(before.n) ?? 0,
          afterN: asNumber(asRecord(row.afterStats).n) ?? 0,
          computedAt: row.computedAt,
        },
      ];
    })
    .sort((a, b) => a.performedAt - b.performedAt || Number(a.verificationId) - Number(b.verificationId))
    .slice(0, VERIFIED_ACTION_LIMIT);
}

export function revenueOf(rows: readonly MarketRowInput[]): PackRevenue[] {
  return [...groupBy(rows, (r) => r.key).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const v = group.map((r) => r.value);
      return { key, label: isMarketKey(key) ? MARKET_LABELS[key] : key, unit: group[0]?.unit ?? '', days: v.length, mean: roundTo(mean(v), 2) ?? 0, min: Math.min(...v), max: Math.max(...v) };
    });
}
